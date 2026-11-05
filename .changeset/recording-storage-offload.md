---
'manifest': patch
---

Allow S3 recording reads to use an explicitly configured, read-only filesystem source during a storage migration. Missing objects can still be read while new recordings are written to S3; existing retention and encryption settings are preserved.
