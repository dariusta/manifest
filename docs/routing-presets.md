# Routing presets

Save a harness's current routing from its Routing page with **Save current as preset**. Choose a preset and **Apply copy** to replace a harness's routing, or select one while creating a harness. **Edit preset** changes its name, primary models, fallback order, response modes, complexity routing and enabled provider connections. Presets belong to the active workspace.

Applying a preset copies its configuration. Later edits or deletion of the preset do not change harnesses that already used it. Saving an edit also does not apply it to the current harness: use **Apply copy** when that is intended.

A snapshot contains default and complexity routes, task-specific assignments, custom header tiers, up to five ordered fallbacks per chain, response/output modes, pinned account labels, enabled connections and per-route model parameters. Parameter scopes for custom header tiers are remapped to new IDs when applied.

The backend reads snapshots in a repeatable-read transaction and applies the replacement in one transaction. Invalid or disconnected models, disabled providers, missing pinned accounts and cross-workspace access are rejected before replacing routing. Deleted and internal Playground harnesses cannot be targeted. Provider secrets and API keys are never included in presets.

The management API is tenant scoped:

| Method | Path | Body |
| --- | --- | --- |
| GET | `/api/v1/routing-presets` | — |
| POST | `/api/v1/routing-presets` | `{name, sourceAgentName}` |
| PATCH | `/api/v1/routing-presets/:id` | `{name?, config?}` |
| DELETE | `/api/v1/routing-presets/:id` | — |
| POST | `/api/v1/routing-presets/:id/apply/:agentName` | — |

Dashboard GETs retain recently used payloads for background refresh, with bounded caches and tenant separation on the server. Aggregate responses stay fresh for 30 seconds and remain usable for five more minutes while a single query refreshes them. These cached aggregates complement the upstream daily usage rollups and request indexes; they do not change the request-counting contract in [the glossary](glossary.md).
