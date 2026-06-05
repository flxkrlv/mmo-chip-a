/** Color helpers. Framework-agnostic, no DOM/canvas imports. */

/** `#rrggbb` → `rgba(r, g, b, a)`. Returns the input unchanged if not a hex. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
