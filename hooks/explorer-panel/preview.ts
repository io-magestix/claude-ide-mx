// Preview engines: which renderer draws a file, plus the pure helpers of the
// image and custom-command engines.

export type CustomEngine = { cmd: string[]; as: 'text' | 'code' | 'markdown' | 'png' }

export type Engine = 'code' | 'markdown' | 'image' | 'svg' | { custom: CustomEngine }

export const ENGINES: Readonly<Record<string, Exclude<Engine, { custom: CustomEngine }>>> = {
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  svg: 'svg',
}

const CUSTOM_AS = new Set<CustomEngine['as']>(['text', 'code', 'markdown', 'png'])

// Lowercased extension of a file name, '' without one (`.bashrc` has none).
const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// The engine for a file name; a custom entry overrides the built-ins.
export function engineOf(name: string, custom?: Record<string, CustomEngine>): Engine {
  const ext = extOf(name)
  if (ext === '') return 'code'
  const own = custom !== undefined && Object.hasOwn(custom, ext) ? custom[ext] : undefined
  if (own !== undefined) return { custom: own }

  return Object.hasOwn(ENGINES, ext) ? ENGINES[ext]! : 'code'
}

// A custom engine's argv with `{path}` and `{out}` substituted in every element.
export const engineArgv = (engine: CustomEngine, path: string, out: string): string[] =>
  engine.cmd.map(arg => arg.split('{path}').join(path).split('{out}').join(out))

// The first non-blank line of a command's output, trimmed.
export const firstLine = (text: string): string | undefined =>
  text
    .split('\n')
    .map(line => line.trim())
    .find(line => line !== '')

// Why a custom engine's run rejected: `timed out` past its timeout (the
// engine says "aborted: still running after 10000ms"), else the message's
// first line (a command that cannot start).
export const runFailure = (message: string): string =>
  /still running after|timed? ?out|timeout/i.test(message) ? 'timed out' : (firstLine(message) ?? 'failed')

// The `previewEngines` userConfig: JSON of ext to `{ cmd, as }`. Bad entries
// are left out, each with one error line.
export function parseEngines(json: string): {
  engines: Record<string, CustomEngine>
  errors: string[]
} {
  const engines: Record<string, CustomEngine> = {}
  const errors: string[] = []
  if (json.trim() === '') return { engines, errors }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    errors.push(`previewEngines: invalid JSON (${err instanceof Error ? err.message : String(err)})`)

    return { engines, errors }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push('previewEngines: expected an object of extension to { cmd, as }')

    return { engines, errors }
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const ext = key.replace(/^\./, '').toLowerCase()
    if (ext === '') {
      errors.push(`previewEngines: empty extension "${key}"`)
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      errors.push(`previewEngines.${key}: expected { cmd, as }`)
      continue
    }
    const { cmd, as } = value as { cmd?: unknown; as?: unknown }
    if (
      !Array.isArray(cmd) ||
      cmd.length === 0 ||
      !cmd.every(arg => typeof arg === 'string') ||
      cmd[0] === ''
    ) {
      errors.push(`previewEngines.${key}: cmd must be a non-empty array of strings`)
      continue
    }
    if (typeof as !== 'string' || !CUSTOM_AS.has(as as CustomEngine['as'])) {
      errors.push(`previewEngines.${key}: as must be one of text, code, markdown, png`)
      continue
    }
    if (as === 'png' && !cmd.some(arg => (arg as string).includes('{out}'))) {
      errors.push(`previewEngines.${key}: a png engine's cmd must write {out}`)
      continue
    }
    engines[ext] = { cmd: [...(cmd as string[])], as: as as CustomEngine['as'] }
  }

  return { engines, errors }
}

// --- Images ---

export const CELL_W = 10 // assumed pixels per terminal column
export const CELL_H = 20 // assumed pixels per terminal row
// The `Image` element's limit on each side: a large Preview is filled, not capped.
export const MAX_COLUMNS = 255
export const MAX_ROWS = 255

// Cells (columns x rows) that fit the room with the picture's aspect, given ~10x20 px cells.
export function fitCells(
  roomColumns: number,
  roomRows: number,
  aspect: number,
): { columns: number; rows: number } {
  const maxC = Math.max(1, Math.min(roomColumns, MAX_COLUMNS))
  const maxR = Math.max(1, Math.min(roomRows, MAX_ROWS))
  const columns = Math.max(1, Math.floor(Math.min(maxC, (maxR * CELL_H * aspect) / CELL_W)))
  const rows = Math.max(1, Math.min(maxR, Math.round((columns * CELL_W) / (CELL_H * aspect))))

  return { columns, rows }
}

// FNV-1a, 8 hex digits: names the cached PNG of one path + mtime (and, with
// a second seed, a draft: `hashPath`).
export function hashOf(text: string, seed = 0x811c9dc5): string {
  let h = seed
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0

  return h.toString(16).padStart(8, '0')
}

export type ConvertTool = 'magick' | 'convert' | 'rsvg-convert'

// ImageMagick's input coder per extension: named outright, so a file's
// content never picks another coder (PDF, PS, MVG, ...).
const CODERS: Readonly<Record<string, string>> = {
  png: 'png',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  gif: 'gif',
  webp: 'webp',
  bmp: 'bmp',
  svg: 'svg',
}

// The longest side of a picture ImageMagick converts, in px.
export const CONVERT_MAX_PX = 2048

// argv converting `src` to a PNG at `out` (first frame of a gif); undefined
// for an extension ImageMagick isn't trusted with. ImageMagick reads `src`
// through the coder its extension names and shrinks it to fit
// CONVERT_MAX_PX a side (`>`: never enlarged).
export function convertArgv(tool: ConvertTool, src: string, out: string): string[] | undefined {
  if (tool === 'rsvg-convert') return ['rsvg-convert', '-f', 'png', '-o', out, src]
  const ext = extOf(src.slice(src.lastIndexOf('/') + 1))
  const coder = Object.hasOwn(CODERS, ext) ? CODERS[ext] : undefined
  if (coder === undefined) return undefined

  return [tool, `${coder}:${src}[0]`, '-thumbnail', `${CONVERT_MAX_PX}x${CONVERT_MAX_PX}>`, `png:${out}`]
}

// Whether a markdown image's target may be drawn: a built-in image or svg
// (a custom engine's file, or any other, never reaches a converter).
export const isPictureFile = (name: string, custom?: Record<string, CustomEngine>): boolean => {
  const engine = engineOf(name, custom)

  return engine === 'image' || engine === 'svg'
}

// Where a converted picture of `path` at `mtime` is written: one file per
// version, so a changed file never draws the old picture.
export const convertedPath = (dir: string, path: string, mtime: number): string =>
  `${dir}/ide-panes-preview-${hashOf(path + '\0' + mtime)}.png`

// Engines whose Preview has a rendered and a source view (the `preview:view` chip).
export const hasSourceView = (engine: Engine): boolean => engine === 'svg' || engine === 'markdown'

// The image info row: `W×H px · size`, the dimensions left out when unknown.
export const imageInfo = (size: string, width?: number, height?: number): string =>
  width !== undefined && height !== undefined ? `${width}×${height} px · ${size}` : size

// An SVG's drawn size in px from its root's `width` / `height` (plain numbers
// or `px`), else its `viewBox`; undefined when neither says.
export function svgSize(text: string): { width: number; height: number } | undefined {
  const root = /<svg\b[^>]*>/i.exec(text)?.[0]
  if (root === undefined) return undefined
  const attr = (name: string): string | undefined =>
    new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(root)?.[1]
  const px = (value: string | undefined): number | undefined => {
    const m = value === undefined ? null : /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/.exec(value)

    return m === null ? undefined : Number(m[1])
  }
  const width = px(attr('width'))
  const height = px(attr('height'))
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    return { width: Math.round(width), height: Math.round(height) }
  }
  const box = attr('viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  if (box?.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && box[3]! > 0) {
    return { width: Math.round(box[2]!), height: Math.round(box[3]!) }
  }

  return undefined
}

const B64 ='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Decodes the first `max` bytes of a base64 string (padding and junk skipped).
function decodeHead(base64: string, max: number): number[] {
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (let i = 0; i < base64.length && out.length < max; i++) {
    const v = B64.indexOf(base64[i]!)
    if (v < 0) continue
    acc = ((acc << 6) | v) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }

  return out
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// A PNG's size from `od -An -tx1 -N24` output (hex bytes, any spacing).
export const pngSizeFromHex = (hex: string): { width: number; height: number } | undefined =>
  pngSize(Uint8Array.from((hex.match(/[0-9a-f]{2}/gi) ?? []).map(b => parseInt(b, 16))))

// Width and height from a PNG's IHDR; undefined when it isn't a PNG.
export function pngSize(data: string | Uint8Array): { width: number; height: number } | undefined {
  const head = typeof data === 'string' ? decodeHead(data, 24) : Array.from(data.subarray(0, 24))
  if (head.length < 24) return undefined
  if (PNG_SIGNATURE.some((b, i) => head[i] !== b)) return undefined
  // IHDR chunk type at 12..15.
  if (String.fromCharCode(head[12]!, head[13]!, head[14]!, head[15]!) !== 'IHDR') return undefined
  const u32 = (at: number) =>
    ((head[at]! << 24) | (head[at + 1]! << 16) | (head[at + 2]! << 8) | head[at + 3]!) >>> 0

  return { width: u32(16), height: u32(20) }
}

// --- Text a Text or Code may hold ---

// Text and Code take tab and newline as their only control characters:
// every other one (C0, DEL, C1) becomes a space.
export const cleanText = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')

// ANSI escape sequences: CSI (`ESC [ ... final`, or the C1 CSI), OSC (up to
// BEL or ST) and any other escape (intermediates, then its final character).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\x20-\x2f]*[\x30-\x7e]?/g

// A command's stdout made drawable: escape sequences dropped, CRLF as LF,
// then cleanText (pdftotext's form feed, a stray CR, ...).
export const cleanOutput = (text: string): string => cleanText(text.replace(ANSI, '').replace(/\r\n/g, '\n'))

// `Code` takes at most this many characters.
export const CODE_MAX_CHARS = 10000

// Lines split into runs, each joined with `\n` shorter than `max`, one run
// per `Code` (every line keeps its row); a line alone that long is cut.
export function codeChunks(lines: readonly string[], max = CODE_MAX_CHARS): string[][] {
  const out: string[][] = []
  let run: string[] = []
  let size = 0
  for (const whole of lines) {
    const line = whole.length >= max ? whole.slice(0, max - 1) : whole
    const grown = run.length === 0 ? line.length : size + 1 + line.length
    if (run.length > 0 && grown >= max) {
      out.push(run)
      run = [line]
      size = line.length
    } else {
      run.push(line)
      size = grown
    }
  }
  if (run.length > 0) out.push(run)

  return out
}

// An `Svg`'s height in CSS px per Preview row (a desktop cell is ~18 px
// tall), so a tall SVG stops at the section's bottom.
export const SVG_ROW_PX = 18
