// Pure layout math for overlays (the Settings sheet).

/** Offset that centers `size` cells in `total` (never negative). */
export function centerOffset(total: number, size: number): number {
  return Math.max(0, Math.floor((total - size) / 2))
}

/** '#rrggbb' scaled toward black by `amount` (0..1); other strings come back unchanged. */
export function darken(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (m === null) return hex
  const n = parseInt(m[1] as string, 16)
  const k = 1 - Math.min(1, Math.max(0, amount))
  const c = (v: number) => Math.round(v * k).toString(16).padStart(2, '0')

  return '#' + c((n >> 16) & 255) + c((n >> 8) & 255) + c(n & 255)
}
