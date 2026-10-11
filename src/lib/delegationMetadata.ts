/** Optional delegation facts must never invalidate the surrounding layout. */
export function delegationId(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
export function delegationTimestamp(value: unknown): number | undefined {
  // Match Rust's integer milliseconds while staying exact in JavaScript.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
