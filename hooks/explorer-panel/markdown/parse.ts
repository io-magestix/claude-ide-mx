// Entry point: markdown text → ParseResult (ast.ts), with the M5 limits.

import type { ParseResult } from './ast'
import { normalize, parseBlocks } from './blocks'

/** M5: past either limit only the first part is parsed and `truncated` is set. */
export const MAX_CHARS = 1024 * 1024
export const MAX_LINES = 20000

/** Cuts normalized text to MAX_CHARS (at a line end) and MAX_LINES. */
export function truncate(text: string): { text: string; truncated: boolean } {
  let truncated = false
  if (text.length > MAX_CHARS) {
    const cut = text.lastIndexOf('\n', MAX_CHARS)
    text = text.slice(0, cut > 0 ? cut : MAX_CHARS)
    truncated = true
  }
  let nl = -1
  for (let n = 0; n < MAX_LINES; n++) {
    nl = text.indexOf('\n', nl + 1)
    if (nl < 0) break
  }
  if (nl >= 0 && nl < text.length - 1) {
    text = text.slice(0, nl)
    truncated = true
  }
  return { text, truncated }
}

export function parse(text: string): ParseResult {
  const cut = truncate(normalize(text))
  const r = parseBlocks(cut.text)
  return { ...r, truncated: cut.truncated }
}

export type * from './ast'
