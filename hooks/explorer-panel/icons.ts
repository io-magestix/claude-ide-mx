// File tree icons: a glyph and a theme role per entry, by exact file name,
// then by extension. `nerd` draws Nerd Fonts glyphs (Private Use Area, one
// cell each in a "Nerd Font Mono"; codepoints from Nerd Fonts 3.5.1
// glyphnames.json, the seti set where it has one); `basic` plain one-cell
// Unicode shapes, the role's color telling the kinds apart; `off` none.
import type { Entry } from './tree'

export type FileIcons = 'off' | 'nerd' | 'basic'

// The theme color an icon is drawn in (`Theme` tokens of the same name).
export type IconRole = 'accent' | 'info' | 'success' | 'warning' | 'danger' | 'muted' | 'text'

export type Icon = { glyph: string; role: IconRole }

type Kind = { nerd: string; role: IconRole }

const nf = (code: number): string => String.fromCodePoint(code)

// Nerd Fonts glyphs, named as in glyphnames.json.
const FOLDER = nf(0xf07b) // fa-folder
const FOLDER_OPEN = nf(0xf07c) // fa-folder_open
const FILE = nf(0xe64e) // seti-default

const k = (code: number, role: IconRole): Kind => ({ nerd: nf(code), role })

const CODE: Record<string, Kind> = {
  ts: k(0xe628, 'info'), // seti-typescript
  tsx: k(0xe625, 'info'), // seti-react
  mts: k(0xe628, 'info'),
  cts: k(0xe628, 'info'),
  js: k(0xe60c, 'warning'), // seti-javascript
  jsx: k(0xe625, 'info'),
  mjs: k(0xe60c, 'warning'),
  cjs: k(0xe60c, 'warning'),
  json: k(0xe60b, 'warning'), // seti-json
  jsonc: k(0xe60b, 'warning'),
  md: k(0xe609, 'info'), // seti-markdown
  markdown: k(0xe609, 'info'),
  mdx: k(0xe609, 'info'),
  py: k(0xe606, 'warning'), // seti-python
  rs: k(0xe68b, 'danger'), // seti-rust
  go: k(0xe627, 'info'), // seti-go
  cs: k(0xe648, 'success'), // seti-c_sharp
  c: k(0xe649, 'info'), // seti-c
  h: k(0xe649, 'muted'),
  cpp: k(0xe646, 'info'), // seti-cpp
  cc: k(0xe646, 'info'),
  hpp: k(0xe646, 'muted'),
  java: k(0xe66d, 'danger'), // seti-java
  kt: k(0xe634, 'accent'), // seti-kotlin
  kts: k(0xe634, 'accent'),
  swift: k(0xe699, 'danger'), // seti-swift
  rb: k(0xe605, 'danger'), // seti-ruby
  php: k(0xe608, 'accent'), // seti-php
  lua: k(0xe620, 'info'), // seti-lua
  dart: k(0xe64c, 'info'), // seti-dart
  scala: k(0xe68e, 'danger'), // seti-scala
  hs: k(0xe61f, 'accent'), // seti-haskell
  ex: k(0xe62d, 'accent'), // seti-elixir
  exs: k(0xe62d, 'accent'),
  jl: k(0xe624, 'accent'), // seti-julia
  zig: k(0xe6a9, 'warning'), // seti-zig
  clj: k(0xe642, 'success'), // seti-clojure
  vue: k(0xe6a0, 'success'), // seti-vue
  svelte: k(0xe697, 'danger'), // seti-svelte
  html: k(0xe60e, 'danger'), // seti-html
  htm: k(0xe60e, 'danger'),
  css: k(0xe614, 'info'), // seti-css
  scss: k(0xe603, 'accent'), // seti-sass
  sass: k(0xe603, 'accent'),
  xml: k(0xe619, 'warning'), // seti-xml
  graphql: k(0xe662, 'accent'), // seti-graphql
  gql: k(0xe662, 'accent'),
  sql: k(0xe64d, 'warning'), // seti-db
  sh: k(0xe795, 'success'), // dev-terminal
  bash: k(0xe795, 'success'),
  zsh: k(0xe795, 'success'),
  fish: k(0xe795, 'success'),
  ps1: k(0xe683, 'info'), // seti-powershell
  gradle: k(0xe660, 'info'), // seti-gradle
  tex: k(0xe69b, 'success'), // seti-tex
  csv: k(0xe64a, 'success'), // seti-csv
  // config
  yml: k(0xe6a8, 'accent'), // seti-yml
  yaml: k(0xe6a8, 'accent'),
  toml: k(0xe615, 'muted'),
  ini: k(0xe615, 'muted'),
  cfg: k(0xe615, 'muted'),
  conf: k(0xe615, 'muted'),
  env: k(0xe615, 'warning'),
  lock: k(0xe672, 'muted'), // seti-lock
  // Unity
  unity: k(0xf06af, 'text'), // md-unity
  prefab: k(0xf06af, 'info'),
  asset: k(0xf06af, 'muted'),
  mat: k(0xf06af, 'success'),
  meta: k(0xe615, 'muted'),
  asmdef: k(0xe60b, 'muted'),
  // media and documents
  png: k(0xe60d, 'accent'), // seti-image
  jpg: k(0xe60d, 'accent'),
  jpeg: k(0xe60d, 'accent'),
  gif: k(0xe60d, 'accent'),
  webp: k(0xe60d, 'accent'),
  bmp: k(0xe60d, 'accent'),
  ico: k(0xe623, 'warning'), // seti-favicon
  svg: k(0xe698, 'warning'), // seti-svg
  pdf: k(0xe67d, 'danger'), // seti-pdf
  zip: k(0xe6aa, 'warning'), // seti-zip
  tar: k(0xe6aa, 'warning'),
  gz: k(0xe6aa, 'warning'),
  tgz: k(0xe6aa, 'warning'),
  '7z': k(0xe6aa, 'warning'),
  mp3: k(0xe638, 'accent'), // seti-audio
  wav: k(0xe638, 'accent'),
  ogg: k(0xe638, 'accent'),
  mp4: k(0xe69f, 'accent'), // seti-video
  mov: k(0xe69f, 'accent'),
  webm: k(0xe69f, 'accent'),
  txt: k(0xe64e, 'muted'), // seti-default
  log: k(0xe64e, 'muted'),
}

// Whole names first: they say more than the extension.
const NAMES: Record<string, Kind> = {
  'package.json': k(0xe616, 'danger'), // seti-npm
  'package-lock.json': k(0xe616, 'muted'),
  'tsconfig.json': k(0xe69d, 'info'), // seti-tsconfig
  dockerfile: k(0xe650, 'info'), // seti-docker
  'docker-compose.yml': k(0xe650, 'info'),
  'docker-compose.yaml': k(0xe650, 'info'),
  makefile: k(0xe673, 'warning'), // seti-makefile
  license: k(0xe60a, 'warning'), // seti-license
  'license.md': k(0xe60a, 'warning'),
  'license.txt': k(0xe60a, 'warning'),
  '.gitignore': k(0xe65d, 'danger'), // seti-git
  '.gitattributes': k(0xe65d, 'danger'),
  '.gitmodules': k(0xe65d, 'danger'),
  '.gitkeep': k(0xe65d, 'muted'),
  '.env': k(0xe615, 'warning'),
}

// One-cell shapes for fonts without Nerd Fonts glyphs.
const BASIC_DIR = '■'
const BASIC_DIR_OPEN = '□'
const BASIC_FILE = '•'

// The icon of an entry named `name`, a dir open when `isExpanded`; undefined
// when icons are off.
export const iconOf = (name: string, kind: Entry['kind'], isExpanded: boolean, icons: FileIcons): Icon | undefined => {
  if (icons === 'off') return undefined
  if (kind === 'dir') {
    const glyph = icons === 'nerd' ? (isExpanded ? FOLDER_OPEN : FOLDER) : isExpanded ? BASIC_DIR_OPEN : BASIC_DIR

    return { glyph, role: 'accent' }
  }
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  const known = NAMES[lower] ?? (dot > 0 ? CODE[lower.slice(dot + 1)] : undefined)
  if (known === undefined) return { glyph: icons === 'nerd' ? FILE : BASIC_FILE, role: 'muted' }

  return { glyph: icons === 'nerd' ? known.nerd : BASIC_FILE, role: known.role }
}

// The icons chosen: the saved choice, else Nerd Fonts glyphs when the
// terminal's font (Tabby's `fonts`, the only terminal whose font is known) is a
// Nerd Font build, else none.
export const iconChoice = (saved: FileIcons | undefined, fonts: readonly string[]): FileIcons =>
  saved ?? (fonts.some(isNerdFont) ? 'nerd' : 'off')

// The style a surface draws: Nerd Fonts glyphs only where the person's own
// terminal font draws them; the desktop app and the editors use their own
// fonts, so they get the basic shapes.
export const iconsFor = (choice: FileIcons, surface: string): FileIcons =>
  choice === 'nerd' && surface !== 'terminal' ? 'basic' : choice

// Whether a font family name is a Nerd Fonts build ("JetBrainsMono Nerd Font",
// "Hack NFM", "FiraCode NF").
export const isNerdFont = (family: string | undefined): boolean =>
  family !== undefined && /nerd ?font|\bNF[MP]?\b/i.test(family)
