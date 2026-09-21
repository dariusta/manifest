import {
  GENERATE_CONTENT_PATH_PREFIX,
  SYNTHETIC_GENERATE_CONTENT_KEYS,
  chatResponseToGenerateContent,
  createGenerateContentStreamTransformer,
  generateContentToChatRequest,
  isGenerateContentBody,
  isGenerateContentPath,
  parseModelAction,
  stripSyntheticGenerateContentKeys,
} from '../google-generate-content-adapter';

/** Pull the JSON payload back out of an `data: {...}\n\n` SSE frame. */
function parseFrame(frame: string | null): Record<string, unknown> {
  if (frame === null) throw new Error('expected an SSE frame');
  expect(frame.startsWith('data: ')).toBe(true);
  expect(frame.endsWith('\n\n')).toBe(true);
  return JSON.parse(frame.slice(6, -2)) as Record<string, unknown>;
}

function chunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('google-generate-content-adapter', () => {
  describe('route helpers', () => {
    it('recognizes the Gemini-native surface by path prefix', () => {
      expect(GENERATE_CONTENT_PATH_PREFIX).toBe('/v1beta/');
      expect(isGenerateContentPath('/v1beta/models/gemini-3-pro:generateContent')).toBe(true);
      expect(isGenerateContentPath('/v1/chat/completions')).toBe(false);
      expect(isGenerateContentPath(undefined)).toBe(false);
    });

    it('splits a model:action segment at the last colon', () => {
      expect(parseModelAction('gemini-3-pro:streamGenerateContent')).toEqual({
        model: 'gemini-3-pro',
        action: 'streamGenerateContent',
      });
      expect(parseModelAction('vendor:model:generateContent')).toEqual({
        model: 'vendor:model',
        action: 'generateContent',
      });
      expect(parseModelAction('gemini-3-pro')).toEqual({ model: 'gemini-3-pro', action: '' });
    });

    it('strips the synthesized routing keys and leaves the rest alone', () => {
      expect(SYNTHETIC_GENERATE_CONTENT_KEYS).toEqual(['model', 'stream']);
      const body = { model: 'auto', stream: true, contents: [], generationConfig: { topP: 1 } };
      expect(stripSyntheticGenerateContentKeys(body)).toEqual({
        contents: [],
        generationConfig: { topP: 1 },
      });
      // The caller's body must not be mutated — routing reads it afterwards.
      expect(body.model).toBe('auto');
    });

    it('detects a Gemini body by its contents field', () => {
      expect(isGenerateContentBody({ contents: [] })).toBe(true);
      expect(isGenerateContentBody({ contents: { parts: [{ text: 'hi' }] } })).toBe(true);
      expect(isGenerateContentBody({ messages: [] })).toBe(false);
      expect(isGenerateContentBody({ contents: 'hi' })).toBe(false);
    });
  });

  describe('generateContentToChatRequest', () => {
    it('converts a minimal single-turn request', () => {
      const chat = generateContentToChatRequest({
        model: 'auto',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      });

      expect(chat).toEqual({
        model: 'auto',
        messages: [{ role: 'user', content: 'Hello' }],
      });
    });

    it('accepts a bare Content object and a bare part object', () => {
      const chat = generateContentToChatRequest({
        contents: { role: 'user', parts: { text: 'Hello' } },
      });

      expect(chat.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(chat.model).toBeUndefined();
    });

    it('drops contents that are neither an array nor an object', () => {
      expect(generateContentToChatRequest({ contents: 'nope' })).toEqual({ messages: [] });
    });

    it('skips non-object entries inside contents and parts', () => {
      const chat = generateContentToChatRequest({
        contents: ['nope', { role: 'user', parts: ['nope', { text: 'Hello' }] }],
      });

      expect(chat.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('emits nothing for a content with no usable parts', () => {
      expect(generateContentToChatRequest({ contents: [{ role: 'user' }] })).toEqual({
        messages: [],
      });
    });

    it('carries the synthesized stream flag through', () => {
      expect(generateContentToChatRequest({ contents: [], stream: true }).stream).toBe(true);
      expect(generateContentToChatRequest({ contents: [], stream: false }).stream).toBeUndefined();
    });

    describe('systemInstruction', () => {
      it('accepts a plain string', () => {
        const chat = generateContentToChatRequest({
          systemInstruction: 'Be terse',
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        });

        expect(chat.messages).toEqual([
          { role: 'system', content: 'Be terse' },
          { role: 'user', content: 'Hi' },
        ]);
      });

      it('joins the text parts of a Content', () => {
        const chat = generateContentToChatRequest({
          systemInstruction: { role: 'system', parts: [{ text: 'One' }, { text: 'Two' }] },
          contents: [],
        });

        expect(chat.messages).toEqual([{ role: 'system', content: 'One\nTwo' }]);
      });

      it('accepts the snake_case alias and a bare { text } object', () => {
        const chat = generateContentToChatRequest({
          system_instruction: { text: 'Be terse' },
          contents: [],
        });

        expect(chat.messages).toEqual([{ role: 'system', content: 'Be terse' }]);
      });

      it('ignores a value with no readable text', () => {
        expect(generateContentToChatRequest({ systemInstruction: 42, contents: [] })).toEqual({
          messages: [],
        });
        expect(
          generateContentToChatRequest({
            systemInstruction: { parts: [{ inlineData: { data: '' } }] },
            contents: [],
          }),
        ).toEqual({ messages: [] });
      });
    });

    describe('parts', () => {
      it('keeps a model turn as an assistant message', () => {
        const chat = generateContentToChatRequest({
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            { role: 'model', parts: [{ text: 'Hello' }] },
            { role: 'assistant', parts: [{ text: 'Still me' }] },
          ],
        });

        expect(chat.messages).toEqual([
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello' },
          { role: 'assistant', content: 'Still me' },
        ]);
      });

      it('drops thought parts so chain-of-thought never replays as content', () => {
        const chat = generateContentToChatRequest({
          contents: [
            { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text: 'Answer' }] },
          ],
        });

        expect(chat.messages).toEqual([{ role: 'assistant', content: 'Answer' }]);
      });

      it('turns inlineData into a data-url image block', () => {
        const chat = generateContentToChatRequest({
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'What is this?' },
                { inlineData: { mimeType: 'image/png', data: 'AAA' } },
              ],
            },
          ],
        });

        expect(chat.messages).toEqual([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
            ],
          },
        ]);
      });

      it('defaults a missing inline mime type to octet-stream and accepts the snake alias', () => {
        const chat = generateContentToChatRequest({
          contents: [{ role: 'user', parts: [{ inline_data: { data: 'AAA' } }] }],
        });

        expect(chat.messages).toEqual([
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: 'data:application/octet-stream;base64,AAA' } },
            ],
          },
        ]);
      });

      it('passes a fileData uri straight through', () => {
        const chat = generateContentToChatRequest({
          contents: [
            { role: 'user', parts: [{ file_data: { file_uri: 'gs://bucket/clip.mp4' } }] },
          ],
        });

        expect(chat.messages).toEqual([
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'gs://bucket/clip.mp4' } }],
          },
        ]);
      });

      it('ignores media parts with nothing to point at', () => {
        const chat = generateContentToChatRequest({
          contents: [
            {
              role: 'user',
              parts: [
                { text: '' },
                { inlineData: { data: 5 } },
                { inlineData: { data: '' } },
                { fileData: { fileUri: '' } },
                { fileData: {} },
                { videoMetadata: { fps: 1 } },
              ],
            },
          ],
        });

        expect(chat.messages).toEqual([]);
      });
    });

    describe('function calls', () => {
      it('keeps the provided call id and pairs the response to it', () => {
        const chat = generateContentToChatRequest({
          contents: [
            { role: 'user', parts: [{ text: 'weather?' }] },
            {
              role: 'model',
              parts: [
                { functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'NY' } } },
              ],
            },
            {
              role: 'user',
              parts: [
                { functionResponse: { id: 'call_1', name: 'get_weather', response: { temp: 20 } } },
              ],
            },
          ],
        });

        expect(chat.messages).toEqual([
          { role: 'user', content: 'weather?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"NY"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
        ]);
      });

      it('mints ids for id-less calls and matches them by name, in order', () => {
        const chat = generateContentToChatRequest({
          contents: [
            {
              role: 'model',
              parts: [
                { function_call: { name: 'search', args: { q: 'a' } } },
                { functionCall: { name: 'search', args: { q: 'b' } } },
              ],
            },
            {
              role: 'user',
              parts: [
                { function_response: { name: 'search', response: { result: 'first' } } },
                { functionResponse: { name: 'search', response: 'second' } },
              ],
            },
          ],
        });

        expect(chat.messages).toEqual([
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_gc_1',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"a"}' },
              },
              {
                id: 'call_gc_2',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"b"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_gc_1', content: 'first' },
          { role: 'tool', tool_call_id: 'call_gc_2', content: 'second' },
        ]);
      });

      it('falls back to a name-derived id when no call is pending', () => {
        const chat = generateContentToChatRequest({
          contents: [{ role: 'user', parts: [{ functionResponse: { name: 'search' } }] }],
        });

        expect(chat.messages).toEqual([
          { role: 'tool', tool_call_id: 'call_gc_search', content: '{}' },
        ]);
      });

      it('tolerates a nameless response', () => {
        const chat = generateContentToChatRequest({
          contents: [{ role: 'user', parts: [{ functionResponse: { response: 'done' } }] }],
        });

        expect(chat.messages).toEqual([
          { role: 'tool', tool_call_id: 'call_gc_', content: 'done' },
        ]);
      });

      it('tolerates a nameless call with non-object args', () => {
        const chat = generateContentToChatRequest({
          contents: [{ role: 'model', parts: [{ functionCall: { args: 'nope' } }] }],
        });

        expect(chat.messages).toEqual([
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_gc_1', type: 'function', function: { name: '', arguments: '{}' } },
            ],
          },
        ]);
      });

      it('carries a thought signature on the tool call', () => {
        const camel = generateContentToChatRequest({
          contents: [
            {
              role: 'model',
              parts: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'sig-a' }],
            },
          ],
        });
        const snake = generateContentToChatRequest({
          contents: [
            {
              role: 'model',
              parts: [{ functionCall: { name: 'f', args: {} }, thought_signature: 'sig-b' }],
            },
          ],
        });

        expect((camel.messages as Record<string, unknown>[])[0]).toMatchObject({
          tool_calls: [{ thought_signature: 'sig-a' }],
        });
        expect((snake.messages as Record<string, unknown>[])[0]).toMatchObject({
          tool_calls: [{ thought_signature: 'sig-b' }],
        });
      });

      it('keeps text alongside a tool call as the message content', () => {
        const chat = generateContentToChatRequest({
          contents: [
            {
              role: 'model',
              parts: [{ text: 'calling' }, { functionCall: { id: 'c1', name: 'f', args: {} } }],
            },
          ],
        });

        expect(chat.messages).toEqual([
          {
            role: 'assistant',
            content: 'calling',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
        ]);
      });

      it('unwraps a { result } envelope so a round-trip does not double-encode', () => {
        const chat = generateContentToChatRequest({
          contents: [
            {
              role: 'user',
              parts: [{ functionResponse: { id: 'c1', name: 'f', response: { result: 'plain' } } }],
            },
          ],
        });

        expect(chat.messages).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'plain' }]);
      });
    });

    describe('tools', () => {
      it('converts function declarations', () => {
        const chat = generateContentToChatRequest({
          contents: [],
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'get_weather',
                  description: 'Look up weather',
                  parameters: { type: 'object', properties: {} },
                },
              ],
            },
          ],
        });

        expect(chat.tools).toEqual([
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Look up weather',
              parameters: { type: 'object', properties: {} },
            },
          },
        ]);
      });

      it('accepts a bare tool object and the snake_case aliases', () => {
        const chat = generateContentToChatRequest({
          contents: [],
          tools: {
            function_declarations: [
              { name: 'f', parameters_json_schema: { type: 'object' } },
              { name: 'g' },
            ],
          },
        });

        expect(chat.tools).toEqual([
          { type: 'function', function: { name: 'f', parameters: { type: 'object' } } },
          { type: 'function', function: { name: 'g' } },
        ]);
      });

      it('omits tools when nothing declares a named function', () => {
        expect(
          generateContentToChatRequest({
            contents: [],
            tools: [
              'nope',
              { googleSearch: {} },
              { functionDeclarations: 'nope' },
              { functionDeclarations: ['nope', { description: 'unnamed' }, { name: '' }] },
            ],
          }).tools,
        ).toBeUndefined();
        expect(generateContentToChatRequest({ contents: [], tools: 'nope' }).tools).toBeUndefined();
      });

      it('maps the function-calling mode onto tool_choice', () => {
        const mode = (value: unknown): unknown =>
          generateContentToChatRequest({
            contents: [],
            toolConfig: { functionCallingConfig: { mode: value } },
          }).tool_choice;

        expect(mode('AUTO')).toBe('auto');
        expect(mode('any')).toBe('required');
        expect(mode('NONE')).toBe('none');
        expect(mode('VALIDATED')).toBeUndefined();
        expect(mode(1)).toBeUndefined();
        expect(
          generateContentToChatRequest({
            contents: [],
            tool_config: { function_calling_config: { mode: 'ANY' } },
          }).tool_choice,
        ).toBe('required');
        expect(
          generateContentToChatRequest({ contents: [], toolConfig: 'nope' }).tool_choice,
        ).toBeUndefined();
        expect(
          generateContentToChatRequest({ contents: [], toolConfig: {} }).tool_choice,
        ).toBeUndefined();
      });
    });

    describe('generationConfig', () => {
      it('maps sampling parameters', () => {
        const chat = generateContentToChatRequest({
          contents: [],
          generationConfig: {
            maxOutputTokens: 256,
            temperature: 0.4,
            topP: 0.9,
            stopSequences: ['STOP'],
          },
        });

        expect(chat).toMatchObject({
          max_tokens: 256,
          temperature: 0.4,
          top_p: 0.9,
          stop: ['STOP'],
        });
      });

      it('accepts the snake_case aliases', () => {
        expect(
          generateContentToChatRequest({
            contents: [],
            generation_config: { max_output_tokens: 8, top_p: 0.1, stop_sequences: ['x'] },
          }),
        ).toMatchObject({ max_tokens: 8, top_p: 0.1, stop: ['x'] });
      });

      it('ignores absent, empty and mistyped fields', () => {
        expect(generateContentToChatRequest({ contents: [], generationConfig: 'nope' })).toEqual({
          messages: [],
        });
        expect(
          generateContentToChatRequest({
            contents: [],
            generationConfig: {
              maxOutputTokens: '256',
              temperature: 'hot',
              topP: 'wide',
              stopSequences: [],
            },
          }),
        ).toEqual({ messages: [] });
      });

      it('maps a JSON response mime type onto response_format', () => {
        expect(
          generateContentToChatRequest({
            contents: [],
            generationConfig: { responseMimeType: 'application/json' },
          }).response_format,
        ).toEqual({ type: 'json_object' });

        expect(
          generateContentToChatRequest({
            contents: [],
            generation_config: {
              response_mime_type: 'application/json',
              response_schema: { type: 'object' },
            },
          }).response_format,
        ).toEqual({
          type: 'json_schema',
          json_schema: { name: 'response', schema: { type: 'object' } },
        });

        expect(
          generateContentToChatRequest({
            contents: [],
            generationConfig: {
              responseMimeType: 'text/plain',
              responseSchema: { type: 'object' },
            },
          }).response_format,
        ).toBeUndefined();
      });
    });
  });

  describe('chatResponseToGenerateContent', () => {
    it('converts a text completion', () => {
      const result = chatResponseToGenerateContent(
        {
          id: 'chatcmpl-1',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        },
        'gemini-3-pro',
      );

      expect(result).toEqual({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Hello' }] },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
        modelVersion: 'gemini-3-pro',
        responseId: 'chatcmpl-1',
      });
    });

    it('flattens array content and skips non-text blocks', () => {
      const result = chatResponseToGenerateContent(
        {
          choices: [
            {
              message: {
                content: [
                  'nope',
                  { type: 'text', text: 'One' },
                  { type: 'text', text: '' },
                  { type: 'image' },
                  { type: 'text', text: 'Two' },
                ],
              },
            },
          ],
        },
        'm',
      );

      expect((result.candidates as Record<string, unknown>[])[0]).toEqual({
        content: { role: 'model', parts: [{ text: 'One' }, { text: 'Two' }] },
        finishReason: 'STOP',
        index: 0,
      });
    });

    it('synthesizes a response id when the upstream sent none', () => {
      const result = chatResponseToGenerateContent({ choices: [], id: '' }, 'm');

      expect(result.candidates).toEqual([]);
      expect(result.usageMetadata).toBeUndefined();
      expect(result.responseId).toMatch(/^gc-[0-9a-f-]{36}$/);
    });

    it('defaults the candidate index to its position and empties a non-object message', () => {
      const result = chatResponseToGenerateContent(
        { choices: ['nope', { message: 'nope' }, { message: { content: 'second' } }] },
        'm',
      );

      expect(result.candidates).toEqual([
        { content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 },
        { content: { role: 'model', parts: [{ text: 'second' }] }, finishReason: 'STOP', index: 1 },
      ]);
    });

    it('treats a missing choices array as no candidates', () => {
      expect(chatResponseToGenerateContent({}, 'm').candidates).toEqual([]);
    });

    it('maps every finish reason Gemini knows', () => {
      const reasonOf = (finish: unknown): unknown => {
        const result = chatResponseToGenerateContent({ choices: [{ finish_reason: finish }] }, 'm');
        return (result.candidates as Record<string, unknown>[])[0]!['finishReason'];
      };

      expect(reasonOf('stop')).toBe('STOP');
      expect(reasonOf('tool_calls')).toBe('STOP');
      expect(reasonOf('function_call')).toBe('STOP');
      expect(reasonOf('length')).toBe('MAX_TOKENS');
      expect(reasonOf('content_filter')).toBe('SAFETY');
      expect(reasonOf('something_new')).toBe('STOP');
      expect(reasonOf(undefined)).toBe('STOP');
    });

    it('converts tool calls into functionCall parts', () => {
      const result = chatResponseToGenerateContent(
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    function: { name: 'get_weather', arguments: '{"city":"NY"}' },
                    thought_signature: 'sig',
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        'm',
      );

      expect((result.candidates as Record<string, unknown>[])[0]).toEqual({
        content: {
          role: 'model',
          parts: [
            {
              functionCall: { name: 'get_weather', args: { city: 'NY' }, id: 'call_1' },
              thoughtSignature: 'sig',
            },
          ],
        },
        finishReason: 'STOP',
        index: 0,
      });
    });

    it('survives unusable tool-call entries', () => {
      const result = chatResponseToGenerateContent(
        {
          choices: [
            {
              message: {
                tool_calls: [
                  'nope',
                  { function: 'nope' },
                  { function: { name: '' } },
                  { id: 5, function: { name: 'a', arguments: 'not-json' } },
                  { function: { name: 'b', arguments: '"scalar"' } },
                  { function: { name: 'c', arguments: '   ' } },
                  { function: { name: 'd' }, thought_signature: '' },
                ],
              },
            },
          ],
        },
        'm',
      );

      expect((result.candidates as Record<string, unknown>[])[0]).toMatchObject({
        content: {
          parts: [
            { functionCall: { name: 'a', args: {} } },
            { functionCall: { name: 'b', args: {} } },
            { functionCall: { name: 'c', args: {} } },
            { functionCall: { name: 'd', args: {} } },
          ],
        },
      });
    });

    it('derives usage totals and cached tokens', () => {
      expect(
        chatResponseToGenerateContent(
          { choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } },
          'm',
        ).usageMetadata,
      ).toEqual({ promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 });

      expect(
        chatResponseToGenerateContent(
          { choices: [], usage: { prompt_tokens: 2, cache_read_tokens: 1 } },
          'm',
        ).usageMetadata,
      ).toEqual({
        promptTokenCount: 2,
        candidatesTokenCount: 0,
        totalTokenCount: 2,
        cachedContentTokenCount: 1,
      });

      expect(
        chatResponseToGenerateContent(
          { choices: [], usage: { prompt_tokens_details: { cached_tokens: 4 } } },
          'm',
        ).usageMetadata,
      ).toEqual({
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
        cachedContentTokenCount: 4,
      });

      expect(
        chatResponseToGenerateContent(
          { choices: [], usage: { prompt_tokens_details: 'nope' } },
          'm',
        ).usageMetadata,
      ).toEqual({ promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 });

      expect(
        chatResponseToGenerateContent({ choices: [], usage: 'nope' }, 'm').usageMetadata,
      ).toBeUndefined();
    });
  });

  describe('createGenerateContentStreamTransformer', () => {
    it('streams text deltas as Gemini candidates', () => {
      const transformer = createGenerateContentStreamTransformer('gemini-3-pro');

      expect(
        parseFrame(transformer.transform(chunk({ choices: [{ delta: { content: 'Hel' } }] }))),
      ).toEqual({
        candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] }, index: 0 }],
        modelVersion: 'gemini-3-pro',
      });
      expect(
        parseFrame(transformer.transform(chunk({ choices: [{ delta: { content: 'lo' } }] }))),
      ).toMatchObject({
        candidates: [{ content: { parts: [{ text: 'lo' }] } }],
      });
    });

    it('reads a bare JSON chunk and a multi-line SSE event', () => {
      const transformer = createGenerateContentStreamTransformer('m');

      expect(
        parseFrame(
          transformer.transform(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })),
        ),
      ).toMatchObject({ candidates: [{ content: { parts: [{ text: 'a' }] } }] });
      expect(
        parseFrame(
          transformer.transform(
            `event: message\ndata: ${JSON.stringify({ choices: [{ delta: { content: 'b' } }] })}\n\n`,
          ),
        ),
      ).toMatchObject({ candidates: [{ content: { parts: [{ text: 'b' }] } }] });
    });

    it('ignores frames that carry no text', () => {
      const transformer = createGenerateContentStreamTransformer('m');

      expect(transformer.transform('')).toBeNull();
      expect(transformer.transform('data: [DONE]\n\n')).toBeNull();
      expect(transformer.transform('data: {not json}\n\n')).toBeNull();
      expect(transformer.transform(chunk(5))).toBeNull();
      expect(transformer.transform(chunk({ choices: 'nope' }))).toBeNull();
      expect(transformer.transform(chunk({ choices: [] }))).toBeNull();
      expect(transformer.transform(chunk({ choices: [{ delta: 'nope' }] }))).toBeNull();
      expect(transformer.transform(chunk({ choices: [{ delta: { content: '' } }] }))).toBeNull();
      expect(transformer.finalize()).toBeNull();
    });

    it('closes the stream with the finish reason and usage', () => {
      const transformer = createGenerateContentStreamTransformer('gemini-3-pro');

      transformer.transform(chunk({ choices: [{ delta: { content: 'Hi' } }] }));
      expect(
        transformer.transform(chunk({ choices: [{ delta: {}, finish_reason: 'length' }] })),
      ).toBeNull();
      transformer.transform(
        chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
      );
      transformer.transform(chunk({ choices: [], usage: null }));

      expect(parseFrame(transformer.finalize())).toEqual({
        candidates: [
          { content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS', index: 0 },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
        modelVersion: 'gemini-3-pro',
      });
    });

    it('accumulates tool-call fragments until finalize', () => {
      const transformer = createGenerateContentStreamTransformer('m');

      transformer.transform(
        chunk({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: 'call_b', function: { name: 'second', arguments: '{"b":' } },
                  { index: 0, id: 'call_a', function: { name: 'first', arguments: '{"a":' } },
                ],
              },
            },
          ],
        }),
      );
      transformer.transform(
        chunk({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
        }),
      );
      transformer.transform(
        chunk({
          choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '2}' } }] } }],
        }),
      );
      transformer.transform(chunk({ choices: [{ delta: { tool_calls: 'nope' } }] }));
      transformer.transform(chunk({ choices: [{ delta: { tool_calls: ['nope', {}] } }] }));

      expect(parseFrame(transformer.finalize())).toEqual({
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { name: 'first', args: { a: 1 }, id: 'call_a' } },
                { functionCall: { name: 'second', args: { b: 2 }, id: 'call_b' } },
              ],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        modelVersion: 'm',
      });
    });

    it('drops an accumulated tool call that never got a name', () => {
      const transformer = createGenerateContentStreamTransformer('m');

      transformer.transform(
        chunk({
          choices: [
            { delta: { tool_calls: [{ index: 0, id: 'call_a', function: { arguments: '{}' } }] } },
          ],
        }),
      );
      transformer.transform(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));

      expect(parseFrame(transformer.finalize())).toEqual({
        candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP', index: 0 }],
        modelVersion: 'm',
      });
    });

    it('indexes a tool-call fragment by position when the delta omits one', () => {
      const transformer = createGenerateContentStreamTransformer('m');

      transformer.transform(
        chunk({
          choices: [{ delta: { tool_calls: [{ function: { name: 'f', arguments: '{}' } }] } }],
        }),
      );

      expect(parseFrame(transformer.finalize())).toMatchObject({
        candidates: [{ content: { parts: [{ functionCall: { name: 'f', args: {} } }] } }],
      });
    });
  });
});
