import type { ThemeName } from '../../types'

// Design tokens, shadcn/ui-like: neutral surfaces, one accent.
export type Theme = {
  name: string
  bg: string // the background the colors are worked out against
  canvas: string | undefined // the background painted; undefined leaves the terminal's own
  surface: string // cards, inputs
  surfaceHover: string
  border: string
  borderStrong: string
  text: string
  muted: string // secondary text
  accent: string // primary actions
  accentText: string // text on accent
  accentHover: string
  danger: string
  success: string
  warning: string
  info: string
  focus: string // focus ring / active border
}

export const THEMES: Record<ThemeName, Theme> = {
  // Raw hex everywhere; `claude` mimics Claude Code's default dark palette.
  // Its neutrals are pure grays: under tmux the engine drops to 256 colors,
  // where warm near-blacks all land on cube cell 59 (#5f5f5f) and frames
  // vanish; grays land on the gray ramp instead (theme.test.ts).
  claude: {
    name: 'claude',
    bg: '#1f1f1f',
    canvas: '#1f1f1f',
    surface: '#2b2b2b',
    surfaceHover: '#363636',
    border: '#4a4a4a',
    borderStrong: '#5c5954',
    text: '#ececec',
    muted: '#9b978f',
    accent: '#d97757',
    accentText: '#1f1f1f',
    accentHover: '#e8906f',
    danger: '#e5484d',
    success: '#4cc38a',
    warning: '#f5a524',
    info: '#5b9cf5',
    focus: '#d97757',
  },
}
