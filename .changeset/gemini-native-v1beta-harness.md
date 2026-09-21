---
'manifest': minor
---

Serve the Google Gen AI SDK natively. Manifest now exposes a Gemini-compatible `/v1beta` surface — `GET /v1beta/models`, `POST /v1beta/models/{model}:generateContent`, and `:streamGenerateContent` — so both official SDKs (`google-genai` for Python, `@google/genai` for TypeScript) can be pointed at Manifest by setting only a base URL and an `mnfst_*` key.

Point the SDK at the Manifest root, *not* at `/v1`: the SDK composes `{base_url}/{api_version}/models/...` itself, so a `/v1` suffix produces `/v1/v1beta/...` and 404s.

Because the SDK has no hook for an `Authorization` header, `x-goog-api-key` is now accepted as an equivalent bearer source for `mnfst_*` keys. `google-genai-sdk` joins the harness list, and the caller classifier reports the SDK language and version separately (`google-genai-python` vs `google-genai-node`).

When a request arrives in Gemini format and the resolved provider also speaks Gemini, it is forwarded natively rather than round-tripped through Chat Completions. That preserves `safetySettings`, `thinkingConfig`, `cachedContent`, inline media parts, `groundingMetadata`, `safetyRatings`, and thought signatures, which the lossy translation dropped.
