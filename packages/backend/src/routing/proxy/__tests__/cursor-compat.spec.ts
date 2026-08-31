import { isResponsesShapedChatBody } from '../cursor-compat';

describe('isResponsesShapedChatBody', () => {
  it('detects the array-input body Cursor Agent posts to /chat/completions', () => {
    expect(
      isResponsesShapedChatBody({
        model: 'auto',
        input: [{ role: 'user', content: 'refactor this' }],
      }),
    ).toBe(true);
  });

  it('detects a plain string input', () => {
    expect(isResponsesShapedChatBody({ model: 'auto', input: 'hello' })).toBe(true);
  });

  it('treats an empty input array as Responses-shaped', () => {
    // An empty turn list is still a Responses request; converting it yields an
    // empty `messages` array, which the validator rejects with the same error
    // an empty chat-completions request would get.
    expect(isResponsesShapedChatBody({ input: [] })).toBe(true);
  });

  it('leaves an ordinary chat-completions body alone', () => {
    expect(
      isResponsesShapedChatBody({
        model: 'auto',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).toBe(false);
  });

  it('prefers messages when a body carries both', () => {
    // Ambiguous bodies keep their existing behaviour rather than silently
    // switching translation path.
    expect(
      isResponsesShapedChatBody({
        messages: [{ role: 'user', content: 'hello' }],
        input: 'ignored',
      }),
    ).toBe(false);
  });

  it('treats an explicitly empty messages array as chat-shaped', () => {
    // `messages: []` is present-but-empty, not absent — a Responses body never
    // carries the key at all.
    expect(isResponsesShapedChatBody({ messages: [], input: 'ignored' })).toBe(false);
  });

  it('returns false for a body with neither key', () => {
    expect(isResponsesShapedChatBody({ model: 'auto' })).toBe(false);
    expect(isResponsesShapedChatBody({})).toBe(false);
  });

  it('returns false for a non-string, non-array input', () => {
    expect(isResponsesShapedChatBody({ input: 42 })).toBe(false);
    expect(isResponsesShapedChatBody({ input: null })).toBe(false);
    expect(isResponsesShapedChatBody({ input: { role: 'user' } })).toBe(false);
    expect(isResponsesShapedChatBody({ input: undefined })).toBe(false);
  });
});
