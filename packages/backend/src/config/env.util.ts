export function optionalPositiveInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * REQUEST_RECORDING_RETENTION_DAYS only. `optionalPositiveInteger` treats 0 as
 * unset, which is what every other variable wants. This setting uses 0, and
 * the words "none" and "forever", to disable retention deletes. Unset and
 * invalid values stay null so the plan and self-hosted defaults still apply.
 */
export function parseRequestRecordingRetentionDays(value: string | undefined): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^(?:none|forever)$/i.test(trimmed) || trimmed === '0') return 0;
  return optionalPositiveInteger(trimmed);
}
