/**
 * Converts between the Gemini `generateContent` wire format and the internal
 * OpenAI chat-completions shape. This is the *inbound* direction: callers that
 * speak the Google Gen AI SDK (`google-genai`, `@google/genai`) against
 * Manifest's `/v1beta` surface.
 *
 * `google-adapter.ts` is the mirror image (outbound: chat → Gemini, for Google
 * upstreams). A Gemini-native request that resolves to a Google upstream never
 * touches either file — `provider-client` forwards the body as-is, so the
 * lossy round-trip only happens when the router picks a non-Google provider.
 */

import { randomUUID } from 'crypto';

import type { OpenAIMessage } from './proxy-types';

/**
 * Keys the `/v1beta` route synthesizes onto a Gemini body so Manifest's
 * routing, validation, recording and stream detection keep working on a body
 * that natively carries neither. They are Manifest-internal and must never
 * reach a provider.
 */
export const SYNTHETIC_GENERATE_CONTENT_KEYS = ['model', 'stream'] as const;

/**
 * URL prefix the Gemini-native inbound surface is mounted at. `v1beta` is the
 * `api_version` both Google Gen AI SDKs default to for the Gemini API, so a
 * client only has to point `base_url` at Manifest — it appends this itself.
 */
export const GENERATE_CONTENT_PATH_PREFIX = '/v1beta/';

/**
 * True for a request on the Gemini-native surface. Used to decide response
 * *shape* outside the proxy pipeline (model list, error envelope), where the
 * apiMode is not threaded through.
 */
export function isGenerateContentPath(url: string | undefined): boolean {
  return url !== undefined && url.startsWith(GENERATE_CONTENT_PATH_PREFIX);
}

/**
 * Split `gemini-3-pro:streamGenerateContent` into its model and method. Gemini
 * pins the method after the LAST colon and model ids never contain one, so a
 * right-anchored split is the safe read.
 */
export function parseModelAction(segment: string): { model: string; action: string } {
  const sep = segment.lastIndexOf(':');
  if (sep < 0) return { model: segment, action: '' };
  return { model: segment.slice(0, sep), action: segment.slice(sep + 1) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Read a field under its camelCase name, falling back to the REST snake_case alias. */
function alias(part: Record<string, unknown>, camel: string, snake: string): unknown {
  return part[camel] !== undefined ? part[camel] : part[snake];
}

/** Drop the synthesized routing fields so the Gemini body goes out untouched. */
export function stripSyntheticGenerateContentKeys(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const key of SYNTHETIC_GENERATE_CONTENT_KEYS) delete out[key];
  return out;
}

/** True when the body looks like a Gemini `generateContent` request. */
export function isGenerateContentBody(body: Record<string, unknown>): boolean {
  return Array.isArray(body.contents) || isRecord(body.contents);
}

function contentList(contents: unknown): Record<string, unknown>[] {
  if (Array.isArray(contents)) return contents.filter(isRecord);
  return isRecord(contents) ? [contents] : [];
}

function partList(content: Record<string, unknown>): Record<string, unknown>[] {
  const parts = content.parts;
  if (Array.isArray(parts)) return parts.filter(isRecord);
  return isRecord(parts) ? [parts] : [];
}

/** `systemInstruction` arrives as a Content, a bare `{ text }`, or a string. */
function systemInstructionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  const texts = partList(value)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean);
  if (texts.length > 0) return texts.join('\n');
  return typeof value.text === 'string' ? value.text : '';
}

function mediaUrl(part: Record<string, unknown>): string | null {
  const inline = alias(part, 'inlineData', 'inline_data');
  if (isRecord(inline)) {
    const data = inline.data;
    if (typeof data !== 'string' || !data) return null;
    const mimeType =
      typeof inline.mimeType === 'string' ? inline.mimeType : 'application/octet-stream';
    return `data:${mimeType};base64,${data}`;
  }
  const file = alias(part, 'fileData', 'file_data');
  if (isRecord(file)) {
    const uri = alias(file, 'fileUri', 'file_uri');
    return typeof uri === 'string' && uri ? uri : null;
  }
  return null;
}

interface ToolCallIds {
  /** Ids minted for functionCalls that arrived without one, queued per name. */
  pending: Map<string, string[]>;
  next: number;
}

function mintToolCallId(ids: ToolCallIds, name: string): string {
  const id = `call_gc_${++ids.next}`;
  const queue = ids.pending.get(name) ?? [];
  queue.push(id);
  ids.pending.set(name, queue);
  return id;
}

/** Pair an id-less functionResponse with the functionCall it answers. */
function takeToolCallId(ids: ToolCallIds, name: string): string {
  const queue = ids.pending.get(name);
  const id = queue?.shift();
  return id ?? `call_gc_${name}`;
}

function toolResponseContent(response: unknown): string {
  // `{ result: "<string>" }` is what google-adapter emits when it converts an
  // OpenAI tool message, so unwrapping it keeps a Gemini → chat → Gemini
  // round-trip through a non-Google provider from nesting JSON twice.
  if (isRecord(response) && typeof response.result === 'string') return response.result;
  if (typeof response === 'string') return response;
  return JSON.stringify(response ?? {});
}

function pushContentMessages(
  content: Record<string, unknown>,
  ids: ToolCallIds,
  messages: OpenAIMessage[],
): void {
  const isModel = content.role === 'model' || content.role === 'assistant';
  const blocks: Record<string, unknown>[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  const toolMessages: OpenAIMessage[] = [];

  for (const part of partList(content)) {
    const call = alias(part, 'functionCall', 'function_call');
    if (isRecord(call)) {
      const name = typeof call.name === 'string' ? call.name : '';
      const id = typeof call.id === 'string' && call.id ? call.id : mintToolCallId(ids, name);
      const args = isRecord(call.args) ? call.args : {};
      const toolCall: Record<string, unknown> = {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      };
      const signature = alias(part, 'thoughtSignature', 'thought_signature');
      if (typeof signature === 'string' && signature) toolCall.thought_signature = signature;
      toolCalls.push(toolCall);
      continue;
    }

    const response = alias(part, 'functionResponse', 'function_response');
    if (isRecord(response)) {
      const name = typeof response.name === 'string' ? response.name : '';
      const id =
        typeof response.id === 'string' && response.id ? response.id : takeToolCallId(ids, name);
      toolMessages.push({
        role: 'tool',
        tool_call_id: id,
        content: toolResponseContent(response.response),
      });
      continue;
    }

    // Thinking summaries come back with `thought: true`. They are model
    // scratch space, not assistant output — replaying them as content would
    // leak chain-of-thought into the next provider's prompt.
    if (typeof part.text === 'string' && part.text && !part.thought) {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }

    const url = mediaUrl(part);
    if (url) blocks.push({ type: 'image_url', image_url: { url } });
  }

  if (blocks.length > 0 || toolCalls.length > 0) {
    const onlyText = blocks.length === 1 && blocks[0]!.type === 'text';
    const message: OpenAIMessage = {
      role: isModel ? 'assistant' : 'user',
      content: onlyText ? (blocks[0]!.text as string) : blocks.length > 0 ? blocks : null,
    };
    if (toolCalls.length > 0) message.tool_calls = toolCalls as OpenAIMessage['tool_calls'];
    messages.push(message);
  }
  messages.push(...toolMessages);
}

function convertFunctionDeclarations(tools: unknown): Record<string, unknown>[] | undefined {
  const list = Array.isArray(tools) ? tools.filter(isRecord) : isRecord(tools) ? [tools] : [];
  const converted: Record<string, unknown>[] = [];
  for (const tool of list) {
    const declarations = alias(tool, 'functionDeclarations', 'function_declarations');
    if (!Array.isArray(declarations)) continue;
    for (const declaration of declarations.filter(isRecord)) {
      if (typeof declaration.name !== 'string' || !declaration.name) continue;
      const fn: Record<string, unknown> = { name: declaration.name };
      if (typeof declaration.description === 'string') fn.description = declaration.description;
      const parameters = alias(declaration, 'parameters', 'parameters_json_schema');
      if (isRecord(parameters)) fn.parameters = parameters;
      converted.push({ type: 'function', function: fn });
    }
  }
  return converted.length > 0 ? converted : undefined;
}

const TOOL_CHOICE_BY_MODE: Readonly<Record<string, string>> = {
  AUTO: 'auto',
  ANY: 'required',
  NONE: 'none',
};

function convertToolChoice(toolConfig: unknown): string | undefined {
  if (!isRecord(toolConfig)) return undefined;
  const callingConfig = alias(toolConfig, 'functionCallingConfig', 'function_calling_config');
  if (!isRecord(callingConfig)) return undefined;
  const mode = callingConfig.mode;
  return typeof mode === 'string' ? TOOL_CHOICE_BY_MODE[mode.toUpperCase()] : undefined;
}

function applyGenerationConfig(config: unknown, chat: Record<string, unknown>): void {
  if (!isRecord(config)) return;
  const maxOutputTokens = alias(config, 'maxOutputTokens', 'max_output_tokens');
  if (typeof maxOutputTokens === 'number') chat.max_tokens = maxOutputTokens;
  if (typeof config.temperature === 'number') chat.temperature = config.temperature;
  const topP = alias(config, 'topP', 'top_p');
  if (typeof topP === 'number') chat.top_p = topP;
  const stopSequences = alias(config, 'stopSequences', 'stop_sequences');
  if (Array.isArray(stopSequences) && stopSequences.length > 0) chat.stop = stopSequences;
  const responseMimeType = alias(config, 'responseMimeType', 'response_mime_type');
  if (responseMimeType !== 'application/json') return;
  const responseSchema = alias(config, 'responseSchema', 'response_schema');
  chat.response_format = isRecord(responseSchema)
    ? { type: 'json_schema', json_schema: { name: 'response', schema: responseSchema } }
    : { type: 'json_object' };
}

/**
 * Gemini `generateContent` → Chat Completions. Used for routing/scoring on
 * every Gemini-native request, and as the wire body when the resolved provider
 * is not Google.
 */
export function generateContentToChatRequest(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];
  const systemText = systemInstructionText(alias(body, 'systemInstruction', 'system_instruction'));
  if (systemText) messages.push({ role: 'system', content: systemText });

  const ids: ToolCallIds = { pending: new Map(), next: 0 };
  for (const content of contentList(body.contents)) {
    pushContentMessages(content, ids, messages);
  }

  const chat: Record<string, unknown> = { messages };
  if (typeof body.model === 'string') chat.model = body.model;
  if (body.stream === true) chat.stream = true;

  const tools = convertFunctionDeclarations(body.tools);
  if (tools) chat.tools = tools;
  const toolChoice = convertToolChoice(alias(body, 'toolConfig', 'tool_config'));
  if (toolChoice) chat.tool_choice = toolChoice;
  applyGenerationConfig(alias(body, 'generationConfig', 'generation_config'), chat);

  return chat;
}

const FINISH_REASON_TO_GEMINI: Readonly<Record<string, string>> = {
  stop: 'STOP',
  tool_calls: 'STOP',
  function_call: 'STOP',
  length: 'MAX_TOKENS',
  content_filter: 'SAFETY',
};

function geminiFinishReason(reason: unknown): string {
  return typeof reason === 'string' ? (FINISH_REASON_TO_GEMINI[reason] ?? 'STOP') : 'STOP';
}

function usageMetadata(usage: unknown): Record<string, unknown> | undefined {
  if (!isRecord(usage)) return undefined;
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : prompt + completion;
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cached =
    typeof usage.cache_read_tokens === 'number'
      ? usage.cache_read_tokens
      : typeof details?.cached_tokens === 'number'
        ? details.cached_tokens
        : undefined;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: completion,
    totalTokenCount: total,
    ...(cached !== undefined ? { cachedContentTokenCount: cached } : {}),
  };
}

function toolCallParts(toolCalls: unknown): Record<string, unknown>[] {
  if (!Array.isArray(toolCalls)) return [];
  const parts: Record<string, unknown>[] = [];
  for (const call of toolCalls.filter(isRecord)) {
    const fn = isRecord(call.function) ? call.function : {};
    const name = typeof fn.name === 'string' ? fn.name : '';
    if (!name) continue;
    let args: Record<string, unknown> = {};
    if (typeof fn.arguments === 'string' && fn.arguments.trim()) {
      try {
        const parsed = JSON.parse(fn.arguments) as unknown;
        if (isRecord(parsed)) args = parsed;
      } catch {
        // A partial or non-JSON argument string is not worth failing the
        // response over — Gemini takes an empty args object.
      }
    }
    const functionCall: Record<string, unknown> = { name, args };
    if (typeof call.id === 'string' && call.id) functionCall.id = call.id;
    const part: Record<string, unknown> = { functionCall };
    const signature = call.thought_signature;
    if (typeof signature === 'string' && signature) part.thoughtSignature = signature;
    parts.push(part);
  }
  return parts;
}

/** Chat Completions response → Gemini `GenerateContentResponse`. */
export function chatResponseToGenerateContent(
  chat: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const choices = Array.isArray(chat.choices) ? chat.choices.filter(isRecord) : [];
  const candidates = choices.map((choice, index) => {
    const message = isRecord(choice.message) ? choice.message : {};
    const parts: Record<string, unknown>[] = [];
    if (typeof message.content === 'string' && message.content) {
      parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const block of message.content.filter(isRecord)) {
        if (typeof block.text === 'string' && block.text) parts.push({ text: block.text });
      }
    }
    parts.push(...toolCallParts(message.tool_calls));
    return {
      content: { role: 'model', parts },
      finishReason: geminiFinishReason(choice.finish_reason),
      index: typeof choice.index === 'number' ? choice.index : index,
    };
  });

  const usage = usageMetadata(chat.usage);
  return {
    candidates,
    ...(usage ? { usageMetadata: usage } : {}),
    modelVersion: model,
    responseId: typeof chat.id === 'string' && chat.id ? chat.id : `gc-${randomUUID()}`,
  };
}

/** Pull the JSON payload out of a parsed SSE event or a bare JSON chunk. */
function eventPayload(chunk: string): string {
  const trimmed = chunk.trim();
  if (!trimmed || !trimmed.includes('data:')) return trimmed;
  return trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('')
    .trim();
}

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export interface GenerateContentStreamTransformer {
  transform: (chunk: string) => string | null;
  /**
   * Trailing Gemini chunk. Gemini SSE has no `[DONE]` sentinel, so this must
   * return the final candidate (or null) and never a sentinel — `pipeStream`
   * only skips its own `[DONE]` when a finalize is supplied.
   */
  finalize: () => string | null;
}

/**
 * Chat Completions SSE → Gemini SSE. Stateful: text deltas stream straight
 * through, while tool-call argument fragments accumulate until `finalize`
 * because Gemini has no partial-`functionCall` representation.
 */
export function createGenerateContentStreamTransformer(
  model: string,
): GenerateContentStreamTransformer {
  const toolCalls = new Map<number, { id?: string; name: string; args: string }>();
  let finishReason: unknown;
  let usage: unknown;
  let sawFinish = false;

  const accumulateToolCalls = (deltaToolCalls: unknown): void => {
    if (!Array.isArray(deltaToolCalls)) return;
    for (const [position, call] of deltaToolCalls.entries()) {
      if (!isRecord(call)) continue;
      const index = typeof call.index === 'number' ? call.index : position;
      const existing = toolCalls.get(index) ?? { name: '', args: '' };
      if (typeof call.id === 'string' && call.id) existing.id = call.id;
      const fn = isRecord(call.function) ? call.function : {};
      if (typeof fn.name === 'string' && fn.name) existing.name = fn.name;
      if (typeof fn.arguments === 'string') existing.args += fn.arguments;
      toolCalls.set(index, existing);
    }
  };

  return {
    transform: (chunk: string): string | null => {
      const payload = eventPayload(chunk);
      if (!payload || payload === '[DONE]') return null;

      let data: Record<string, unknown>;
      try {
        const parsed = JSON.parse(payload) as unknown;
        if (!isRecord(parsed)) return null;
        data = parsed;
      } catch {
        return null;
      }

      if (data.usage !== undefined && data.usage !== null) usage = data.usage;

      const choices = Array.isArray(data.choices) ? data.choices.filter(isRecord) : [];
      const choice = choices[0];
      if (!choice) return null;
      if (choice.finish_reason != null) {
        finishReason = choice.finish_reason;
        sawFinish = true;
      }

      const delta = isRecord(choice.delta) ? choice.delta : {};
      accumulateToolCalls(delta.tool_calls);
      const text = typeof delta.content === 'string' ? delta.content : '';
      if (!text) return null;

      return sseChunk({
        candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }],
        modelVersion: model,
      });
    },
    finalize: (): string | null => {
      const parts: Record<string, unknown>[] = [];
      for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)) {
        if (!call.name) continue;
        parts.push(
          ...toolCallParts([
            { id: call.id, type: 'function', function: { name: call.name, arguments: call.args } },
          ]),
        );
      }
      const metadata = usageMetadata(usage);
      // Nothing to close out: the upstream produced neither a finish reason,
      // tool calls, nor usage, so emitting a bare candidate would invent one.
      if (!sawFinish && parts.length === 0 && !metadata) return null;
      return sseChunk({
        candidates: [
          {
            content: { role: 'model', parts },
            finishReason: geminiFinishReason(finishReason),
            index: 0,
          },
        ],
        ...(metadata ? { usageMetadata: metadata } : {}),
        modelVersion: model,
      });
    },
  };
}
