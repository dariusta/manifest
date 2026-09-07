---
'manifest-backend': minor
'manifest-frontend': minor
---

Custom providers now keep the input modalities their `/models` endpoint publishes (OpenRouter-style `architecture.input_modalities`), so a vision model behind an OpenAI-compatible server shows up as text+image in the model picker instead of text-only. The modalities are stored per model on the custom provider, shown as a badge in the provider form, and surfaced on `available-models`. Unknown stays unknown so models.dev fallback still applies.
