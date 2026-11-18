---
'manifest': patch
---

Add an optional S3 key prefix and a read-only filesystem fallback for request recordings, and allow `REQUEST_RECORDING_RETENTION_DAYS=0` (`none` or `forever`) to disable retention deletes.

### Upgrade

- `REQUEST_RECORDING_RETENTION_DAYS` values that used to be ignored, and therefore kept the plan default, now prevent the process from booting. That includes `never`, `off`, `disabled`, `-1`, `00`, `0.0`, `-0`, `+0`, `NaN`, `∞`, `1e3`, `30d`, `1.5`, and integers that are not safe positive integers. Unset or blank still uses the plan default (Cloud Free 7 days, Cloud Pro 365 days, self-hosted 365 days).
- `REQUEST_RECORDING_RETENTION_DAYS=0` used to mean that plan default. It now means keep every recording: the cleanup cron runs and deletes nothing. `none` and `forever` do the same.
- A `REQUEST_RECORDING_S3_PREFIX` that contains `..`, `.`, or a control character now prevents boot when S3 storage is selected. Surrounding whitespace, including a trailing CR or tab, is trimmed and does not fail boot.
