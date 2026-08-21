/**
 * Cursor compatibility for the OpenAI-compatible surface.
 *
 * Cursor's "Override OpenAI Base URL" points every mode at one base URL and
 * only ever POSTs to `/chat/completions`. Ask sends an ordinary
 * chat-completions body, but Agent and Plan send a **Responses-API-shaped**
 * body — `input` instead of `messages`, `instructions` instead of a system
 * message, flat tool definitions instead of `{type:'function',function:{…}}` —
 * to that same path, while still expecting a chat-completions reply.
 *
 * That is the whole incompatibility. Manifest already owns both halves of the
 * translation (`toChatCompletionsRequest` in `responses-adapter.ts`), so the
 * only thing missing is recognising the shape when it arrives on the chat
 * path. Detection is deliberately structural rather than User-Agent based:
 * Cursor publishes no stable UA, and requests reach Manifest from Cursor's
 * backend rather than the editor, so any header sniff would be guesswork.
 *
 * The reply format is unaffected — `apiMode` stays `chat_completions`, so the
 * caller gets chat-completions JSON/SSE exactly as it expects.
 */

/**
 * True when a body posted to `/chat/completions` is really a Responses-API
 * request.
 *
 * `messages` is the discriminator: every genuine chat-completions request
 * carries it, and no Responses request does. A body with both is treated as
 * chat-completions and left alone, so a client that sends a stray `input`
 * alongside real `messages` keeps its current behaviour.
 */
export function isResponsesShapedChatBody(body: Record<string, unknown>): boolean {
  if (body.messages !== undefined) return false;
  return typeof body.input === 'string' || Array.isArray(body.input);
}
