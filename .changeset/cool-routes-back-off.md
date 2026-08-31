---
'manifest': patch
---

Put a provider route into cooldown on an upstream 529, not just a 429, and report the sidelining status honestly. A 529 is the provider explicitly shedding load, but it previously earned no backoff at all, so every subsequent request re-dialled the route that had just asked to be left alone. A route cooling down after a 529 now answers 529 rather than masquerading as a 429. The fallback log line also gained `key=`, so slots that share model/provider/auth_type and differ only by account are no longer indistinguishable in the logs.
