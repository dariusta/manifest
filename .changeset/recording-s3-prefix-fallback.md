---
'manifest': patch
---

Add an optional S3 key prefix and a read-only filesystem fallback for request recordings, and allow `REQUEST_RECORDING_RETENTION_DAYS=0` (`none` or `forever`) to disable retention deletes.
