export function optionalPositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

const INVALID_RECORDING_RETENTION =
  'Invalid REQUEST_RECORDING_RETENTION_DAYS. Accepted values: a positive integer, or 0, none, or forever to disable retention deletes. Leave it unset to keep the plan default.';

/**
 * REQUEST_RECORDING_RETENTION_DAYS only. `optionalPositiveInteger` treats 0 as
 * unset, which is what every other variable wants. This setting uses 0, and
 * the words "none" and "forever", to disable retention deletes. A blank value
 * stays null so the plan and self-hosted defaults still apply. Any other
 * value fails boot instead of silently turning deletes back on.
 */
export function parseRequestRecordingRetentionDays(value: string | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(?:none|forever)$/i.test(trimmed) || trimmed === '0') return 0;
  const parsed = optionalPositiveInteger(trimmed);
  if (parsed == null) throw new Error(INVALID_RECORDING_RETENTION);
  return parsed;
}
