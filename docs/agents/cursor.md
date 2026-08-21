# Cursor

Point Cursor at Manifest so its chat traffic routes through your fallback chain
and lands in the dashboard like any other agent.

This is the **inbound** direction — Cursor is a client of Manifest. Routing the
other way is not possible: Cursor has no inference API. Its own docs state that
the Cloud Agents API and SDKs "are not a standalone model-inference or
chat-completions API", so a `crsr_` User API Key cannot be added to Manifest as
a provider. See [What will not work](#what-will-not-work).

## Requirements

- A **paid Cursor plan**. Cursor requires one even though you supply the
  endpoint and the key.
- **Cursor 3.15.20 or newer.** Earlier 3.15.x builds had a bug that rejected
  input in the base-URL field.
- A **publicly reachable HTTPS** Manifest deployment with a valid certificate.
  Cursor routes every request through its own backend for final prompt
  construction, so it is Cursor's servers — not the editor — that call Manifest.
  `localhost`, LAN addresses, VPN-only DNS, and self-signed certificates will
  not work.

## Setup

1. Create an agent in Manifest with platform **Cursor**, and copy its `mnfst_`
   key.
2. In Cursor, open **Settings → Models** and find the OpenAI API-key section.
3. Enable **Override OpenAI Base URL** and enter:
   - **Base URL** — `https://<your-manifest-host>/v1`
   - **API key** — the `mnfst_` agent key
4. Add a custom model whose name **exactly matches** an `id` from
   `GET /v1/models`:

   ```bash
   curl -s https://<your-manifest-host>/v1/models \
     -H "Authorization: Bearer mnfst_..." | jq '.data[].id'
   ```

5. Save, then test **Ask**, **Plan**, and **Agent** separately. A model that
   verifies successfully has only proven discovery and auth — it has not proven
   Agent works.

### Choosing a model name

Prefer a **provider-qualified id** such as `openai/gpt-5.4-nano` over the bare
`auto` route. Cursor ships its own `auto` and `auto-smart` models, and it
rejects a custom model whose name collides with a built-in
(`The model "X" is already available as "Y"`) — a check it performs locally,
before any request reaches Manifest.

## What Manifest does for Cursor

Cursor points every mode at one base URL and only ever POSTs to
`/chat/completions`, but the body shape differs by mode:

| Cursor mode | Body posted to `/chat/completions` | Handling |
|---|---|---|
| Ask | ordinary chat-completions (`messages`) | forwarded as-is |
| Plan, Agent | **Responses-shaped** (`input`, `instructions`, flat tool defs) | translated |

`routing/proxy/cursor-compat.ts` detects the Responses shape structurally — a
body with `input` and no `messages` — and runs it through the existing
Responses → chat-completions converter. That gives the scorer real turns to
route on and hands the provider a body it understands. The reply is unaffected:
`apiMode` stays `chat_completions`, so Cursor gets chat-completions JSON/SSE
back exactly as it expects.

Detection is structural rather than User-Agent based on purpose. Cursor
publishes no stable User-Agent, and because requests arrive from Cursor's
backend rather than the editor, any header sniff would be guesswork.

## Limits and caveats

This is an **undocumented, degraded** compatibility path on Cursor's side, not a
first-class integration. Cursor does not document the base-URL override, and it
can change without notice.

- **Tab completion never uses Manifest.** Cursor is explicit that Tab keeps
  using its built-in models. Custom keys apply to chat models only.
- **Agent parity is not guaranteed.** Cursor gates custom keys by mode and
  model server-side, so a model can work in Ask and be refused in Agent.
- **Subagents may ignore the override** and fall back to Cursor's own routing.
- **Images and vision may bypass the override** — Cursor has had a hardcoded
  `api.openai.com` validation path.
- **The override is global for OpenAI traffic.** Selecting a Cursor-hosted
  OpenAI model while it is enabled can redirect that model to Manifest too.
  Turn the override off before going back to Cursor-hosted models, unless
  Manifest also serves those model names.
- **Cursor's Zero Data Retention policy does not apply** to bring-your-own-key
  traffic. Your data follows the privacy policy of whichever provider Manifest
  routes to.

## What will not work

Adding Cursor to Manifest as an outbound **provider**. A Cursor User API Key
authenticates the Cloud Agents API (`POST /v1/agents` plus asynchronous runs and
SSE), the Agent SDKs, and the headless `agent` CLI. None of those is a
completion endpoint, and there is no OpenAI- or Anthropic-compatible surface
behind `api.cursor.com` to proxy to.

Bridging a completion request onto a Cloud Agent run is technically possible but
was deliberately not built: it would provision a cloud agent per request, reject
caller tool calls, and rarely return a first token inside `STREAM_WARMUP_MS`.
