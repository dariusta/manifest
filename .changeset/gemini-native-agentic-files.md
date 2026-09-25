---
'manifest': minor
---

Serve Google's **agentic mode** and **Files API** through Manifest. `client.interactions.create()` and `client.files.upload()` from the official `google-genai` SDK now work against a Manifest base URL with only an `mnfst_*` key — including agentic video, which needs both surfaces at once because agentic mode never inlines media, it ships a file `uri`.

These two surfaces deliberately bypass the router. A file handle and an interaction id are allocated by Google inside one project, so scoring a request that carries one and sending it elsewhere can only 404; and agentic mode runs its tool loop server-side, so `previous_interaction_id`, `google_search_call` and `code_execution_call` steps have no representation in the Chat Completions shape Manifest routes on and would be dropped silently. Manifest authenticates the caller with its own key, resolves that tenant's Google credential (API key preferred, Antigravity subscription second), and relays bytes through untouched — which also means SSE steps arrive live, with upstream EOF as the terminator since Gemini sends no `[DONE]`.

Resumable uploads never hand Google's upload URL to the caller. `X-Goog-Upload-URL` is swapped for an opaque, tenant-scoped ticket that routes the bytes back through Manifest; relaying it verbatim would send the media straight to Google using a credential the caller was never given. An unknown ticket is a 404, not a 403, so it cannot be used to probe whether another tenant has an upload in flight.
