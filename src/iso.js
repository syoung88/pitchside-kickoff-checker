// Canonical UTC string: YYYY-MM-DDTHH:MM:SSZ (no milliseconds).
export function toIsoZ(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
