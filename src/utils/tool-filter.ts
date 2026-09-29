/**
 * Filter a tool map down to an allowlist. A missing or empty allowlist means
 * "no restriction" and returns the full map unchanged.
 */
export function filterToolsByAllowlist<T>(all: Record<string, T>, allowed?: readonly string[]): Record<string, T> {
  if (!allowed || allowed.length === 0) return all;
  const allowedSet = new Set(allowed);
  return Object.fromEntries(Object.entries(all).filter(([name]) => allowedSet.has(name)));
}
