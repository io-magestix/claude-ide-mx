// Design tokens, shadcn/ui-like: neutral surfaces, one accent.
export type Theme = {
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
