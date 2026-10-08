// The Explorer's side of rendered markdown (pure): where a link goes, which
// links draw as a `Link`, the link hit list of a window of rows, and image
// rows grown into the rows their picture takes.

import { slugify } from './blocks'
import type { Layout, MdRow, Span } from './rows'
import { colsOf } from '../../shared/hscroll'

/** A local image of an `image` row, sized in cells, drawn by the terminal's `Image`. */
export type Picture = { png: string; mtime: number; columns: number; rows: number }

/**
 * A Preview row of rendered markdown: a layout row, or one row of a picture
 * (`part` 0 to `rows - 1`; `at` the image row's index in the layout).
 */
export type ViewRow =
  | MdRow
  | ({ kind: 'picture'; prefix: Span[]; alt: string; src: string; part: number; at: number } & Picture)

export type MdView = { rows: ViewRow[]; anchors: Map<string, number> }

/** Each `image` row with a picture grows into `rows` picture rows; anchors move with them. */
export function expandPictures(laid: Layout, pictures: ReadonlyMap<number, Picture>): MdView {
  if (pictures.size === 0) return { rows: laid.rows, anchors: laid.anchors }
  const rows: ViewRow[] = []
  const at: number[] = []
  laid.rows.forEach((row, i) => {
    at.push(rows.length)
    const pic = row.kind === 'image' ? pictures.get(i) : undefined
    if (row.kind !== 'image' || pic === undefined) {
      rows.push(row)
      return
    }
    for (let part = 0; part < Math.max(1, pic.rows); part++) {
      rows.push({ kind: 'picture', prefix: row.prefix, alt: row.alt, src: row.src, part, at: i, ...pic })
    }
  })
  const anchors = new Map<string, number>()
  for (const [slug, i] of laid.anchors) anchors.set(slug, at[i] ?? i)

  return { rows, anchors }
}

/** `path` with `.` and `..` segments folded; `undefined` when `..` climbs past `/`. */
export function normalizePath(path: string): string | undefined {
  const out: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return undefined
      out.pop()
    } else out.push(seg)
  }

  return '/' + out.join('/')
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** A path written in `file` (relative to its dir; `/x` from `root`) when it stays inside `root`. */
export function localPath(written: string, file: string, root: string): string | undefined {
  const rel = decode(written.replace(/[?#].*$/, ''))
  if (rel === '' || SCHEME.test(rel) || rel.startsWith('//')) return undefined
  const dir = file.slice(0, file.lastIndexOf('/')) || '/'
  const path = normalizePath(rel.startsWith('/') ? root + rel : dir + '/' + rel)
  if (path === undefined) return undefined

  return path === root || path.startsWith(root === '/' ? '/' : root + '/') ? path : undefined
}

export type LinkTarget =
  | { kind: 'anchor'; slug: string }
  | { kind: 'file'; path: string; slug?: string }
  | { kind: 'url'; url: string }
  | { kind: 'outside'; written: string }

/** Where a link of the markdown file `file` goes. */
export function linkTarget(href: string, file: string, root: string): LinkTarget {
  if (href.startsWith('#')) return { kind: 'anchor', slug: decode(href.slice(1)) }
  if (SCHEME.test(href) || href.startsWith('//')) return { kind: 'url', url: href }
  const path = localPath(href, file, root)
  if (path === undefined) return { kind: 'outside', written: href }
  const hash = href.indexOf('#')

  return hash < 0 ? { kind: 'file', path } : { kind: 'file', path, slug: decode(href.slice(hash + 1)) }
}

/** The row of heading `slug`: as written, else as a heading's text would slug. */
export const anchorRow = (anchors: ReadonlyMap<string, number>, slug: string): number | undefined =>
  anchors.get(slug) ?? anchors.get(slug.toLowerCase()) ?? anchors.get(slugify(slug))

/**
 * Whether a span's link draws as a `Link`: http(s) on the terminal, `https:`
 * alone on remote surfaces (desktop refuses others), printable ASCII, never in
 * a table row (a terminal without OSC 8 writes the URL after the label there,
 * breaking the borders). Every other link draws as underlined accent text.
 */
export function isLinkable(href: string, surface: string, isTable: boolean): boolean {
  if (isTable || !/^[\x21-\x7e]{1,2048}$/.test(href)) return false

  return surface === 'terminal' ? /^https?:\/\//i.test(href) : /^https:\/\//i.test(href)
}

/** One pressable link run of a drawn row: `y` the row in the window, `x` its first column. */
export type LinkHit = { y: number; x: number; width: number; href: string; spans: Span[] }

/**
 * The link runs of a window of rows that `isPressable` takes (consecutive
 * spans of one href merge), positioned by columns. Only text rows hold links.
 */
export function linkHits(rows: readonly ViewRow[], isPressable: (href: string, row: MdRow) => boolean): LinkHit[] {
  const hits: LinkHit[] = []
  rows.forEach((row, y) => {
    if (row.kind !== 'text') return
    let x = 0
    let last: LinkHit | undefined
    for (const span of row.spans) {
      const w = colsOf(span.text)
      const href = span.style?.href
      if (href !== undefined && w > 0 && isPressable(href, row)) {
        if (last !== undefined && last.href === href && last.x + last.width === x) {
          last.width += w
          last.spans.push(span)
        } else {
          last = { y, x, width: w, href, spans: [span] }
          hits.push(last)
        }
      } else last = undefined
      x += w
    }
  })

  return hits
}
