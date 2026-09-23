---
'manifest': patch
---

Surface curated subscription models to existing connections without a manual refresh. `cached_models` is a discovery-time snapshot, so a `knownModels` addition (Claude Opus 5.5, Grok 4.7) never reached a connection made before it until someone clicked "Refresh models" on that connection. The picker now tops subscription snapshots up with the curated catalog at read time, the same way it already reconciles their context windows.
