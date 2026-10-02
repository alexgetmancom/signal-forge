/** The number itself, or null when the value is absent, not a number, or not finite. */
export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
