/*
 * Component library of the ui-kit mod: pure functions (el, theme, props) -> tree.
 * No `$` in here; each pane's index.tsx passes its handlers as callbacks.
 *
 * Findings (kit-verified = checked with the test kit; paint is NOT checked, the kit
 * returns trees, so how a tree looks in a real terminal is the author's eye):
 * - LIVE-VERIFIED (real terminal): a plain Button of blank label laid absolutely over a colored
 *   Text paints its spaces over the Text, so the control draws empty; a Text drawn over the
 *   Button shows but swallows the click. So terminal controls use the Button's OWN label:
 *   keyed Box chrome (backgroundColor, hover) > plain Button (label, press). A Button
 *   has no color prop: its label is the terminal's default foreground, assumed light
 *   (`#e6e6e6`). Fills are therefore darkened by `onDefaultFg` (WCAG contrast >= 4.5 against
 *   that foreground); outline/ghost/link have no fill on a dark theme. On a light theme (bg
 *   luminance > 0.5) the page is white while labels stay light, so `chromeBg` gives those
 *   controls a darkened-surface fill. Colored glyphs (checkbox, radio, switch track, pill caps)
 *   are a separate Text BESIDE the Button, never under it. Button `hover` (underline) works
 *   inside the keyed chrome Box. Desktop/vscode/mobile get a native Button.
 * - Keyed Box + `hover` ({ backgroundColor, borderColor }) and Text `hover` ({ color })
 *   validate (kit-verified); no hook runs. Hover on a Text/Button needs an enclosing keyed Box.
 * - Hex colors validate everywhere (theme tokens are raw hex).
 * - Section titles: a bordered Box clips its children, so the title is an absolute Box
 *   (top=0) after the bordered Box inside an unbordered wrapper (Card).
 * - Pill caps are half blocks: `▐` (left cap) and `▌` (right cap) in the fill color.
 * - Progress is eighth blocks over a track-colored background, so the partial cell blends.
 */
import type { ElementTable, RenderChildren, RenderSurface } from 'claude-code'

import type { Theme } from './theme'

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link'
type Tone = 'info' | 'success' | 'warning' | 'destructive'

const isTerminal = (surface: RenderSurface | undefined): boolean => (surface ?? 'terminal') === 'terminal'

/** '#000000' or '#ffffff', whichever reads on `hex`. */
export function contrast(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (m === null) return '#ffffff'
  const n = parseInt(m[1] as string, 16)
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255

  return lum > 0.6 ? '#000000' : '#ffffff'
}

const rgb = (hex: string): [number, number, number] | undefined => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (m === null) return undefined
  const n = parseInt(m[1] as string, 16)

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** WCAG relative luminance (0..1) of a hex color; 0 when unparsable. */
export function luminance(hex: string): number {
  const c = rgb(hex)
  if (c === undefined) return 0
  const [r, g, b] = c.map(v => {
    const x = v / 255

    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }) as [number, number, number]

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two hex colors. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The terminal's default foreground, as far as a Button label is concerned (light on dark). */
export const DEFAULT_FG = '#e6e6e6'

/** `hex` darkened until its contrast with the default foreground is at least 4.5. */
export function onDefaultFg(hex: string): string {
  const c = rgb(hex)
  if (c === undefined) return hex
  let k = 1
  let out = hex
  for (let i = 0; i < 40 && contrastRatio(out, DEFAULT_FG) < 4.5; i++) {
    k -= 0.05
    out = '#' + c.map(v => Math.round(v * k).toString(16).padStart(2, '0')).join('')
  }

  return out
}

/** Fill for controls that have none on a dark theme: a light theme gets a darkened surface (labels stay light). */
const chromeBg = (t: Theme): string | undefined => (luminance(t.bg) > 0.5 ? onDefaultFg(t.surface) : undefined)

/** Up to two initials of a name, uppercase. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase()

  return ((parts[0] as string)[0] as string).toUpperCase() + ((parts[1] as string)[0] as string).toUpperCase()
}

/** `value` (0..1) as `width` cells: full blocks and one eighth block; the rest is blank. */
export function barString(value: number, width: number): string {
  const EIGHTHS = ' ▏▎▍▌▋▊▉█'
  const v = Math.min(1, Math.max(0, value))
  const eighths = Math.round(v * width * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  const out = '█'.repeat(full) + (part > 0 ? (EIGHTHS[part] as string) : '')

  return out + ' '.repeat(Math.max(0, width - out.length))
}

const tone = (t: Theme, kind: Tone | 'default'): string =>
  kind === 'info' ? t.info : kind === 'success' ? t.success : kind === 'warning' ? t.warning : kind === 'destructive' ? t.danger : t.accent

/** Page: paints the theme background across the pane (light themes look light). */
export function Page(el: ElementTable, t: Theme, children: RenderChildren, rows?: number) {
  const { Box } = el

  return (
    <Box key="page" flexDirection="column" width="100%" minHeight={rows} backgroundColor={t.bg} paddingX={1} paddingY={1} gap={1}>
      {children}
    </Box>
  )
}

export function Separator(el: ElementTable, t: Theme, props: { width?: number; vertical?: boolean } = {}) {
  const { Box, Text } = el
  if (props.vertical === true) return <Text color={t.border}>{'│\n'.repeat(Math.max(1, props.width ?? 1)).trimEnd()}</Text>
  if (props.width !== undefined) return <Text color={t.border}>{'─'.repeat(props.width)}</Text>

  return (
    <Box width="100%" height={1} overflow="hidden">
      <Text color={t.border} wrap="wrap">{'─'.repeat(300)}</Text>
    </Box>
  )
}

export type BtnProps = {
  label: string
  variant?: Variant
  size?: 'sm' | 'md' // sm: one row; md: three rows with a round border
  icon?: string
  pill?: boolean
  onPress: () => void
  key: string
  surface?: RenderSurface
}

/**
 * Styled button. Terminal: keyed Box chrome (bg, round border, hover) + colored Text label
 * + an absolute plain Button over it. Other surfaces: the native Button.
 */
export function Btn(el: ElementTable, t: Theme, p: BtnProps) {
  const { Box, Text, Button } = el
  const variant = p.variant ?? 'secondary'
  const text = (p.icon !== undefined ? p.icon + ' ' : '') + p.label
  if (!isTerminal(p.surface)) {
    return <Button key={p.key} label={text} variant={variant === 'primary' ? 'primary' : variant === 'secondary' ? 'secondary' : undefined} onPress={p.onPress} />
  }

  const light = chromeBg(t)
  const fill = {
    primary: { bg: onDefaultFg(t.accent), hover: onDefaultFg(t.accentHover), border: onDefaultFg(t.accent) },
    secondary: { bg: onDefaultFg(t.surface), hover: onDefaultFg(t.surfaceHover), border: onDefaultFg(t.surface) },
    outline: { bg: light, hover: onDefaultFg(t.surfaceHover), border: t.borderStrong },
    ghost: { bg: light, hover: onDefaultFg(t.surfaceHover), border: undefined },
    danger: { bg: onDefaultFg(t.danger), hover: onDefaultFg(t.danger), border: onDefaultFg(t.danger) },
    link: { bg: light, hover: undefined, border: undefined },
  }[variant]
  const sm = p.size === 'sm'
  const bordered = !sm && fill.border !== undefined && !p.pill
  const hoverBorderColor = bordered ? (variant === 'outline' ? t.focus : variant === 'danger' ? undefined : fill.hover) ?? fill.border : undefined
  const label = (
    <Button key={p.key} plain label={text} hover={{ underline: true }} onPress={p.onPress} />
  )
  // A hover prop set to undefined is refused ("borderColor is a undefined"): leave the key out.
  const hover =
    fill.hover === undefined
      ? undefined
      : hoverBorderColor !== undefined
        ? { backgroundColor: fill.hover, borderColor: hoverBorderColor }
        : { backgroundColor: fill.hover }

  if (p.pill) {
    const cap = fill.bg ?? onDefaultFg(t.surface)
    const capHover = fill.hover ?? cap
    return (
      <Box key={p.key + ':chrome'} flexDirection="row">
        <Text color={cap} hover={{ color: capHover }}>▐</Text>
        <Box backgroundColor={cap} hover={{ backgroundColor: capHover }}>{label}</Box>
        <Text color={cap} hover={{ color: capHover }}>▌</Text>
      </Box>
    )
  }

  return (
    <Box
      key={p.key + ':chrome'}
      backgroundColor={fill.bg}
      borderStyle={bordered ? 'round' : undefined}
      borderColor={bordered ? fill.border : undefined}
      paddingX={sm ? 1 : 2}
      hover={hover}
    >
      {label}
    </Box>
  )
}

export type CardProps = {
  title: string
  description?: string
  footer?: RenderChildren
  children?: RenderChildren
  width?: number
  key?: string
}

/** Round bordered card: the title sits on the top border (absolute Box after the bordered one). */
export function Card(el: ElementTable, t: Theme, p: CardProps) {
  const { Box, Text } = el

  return (
    <Box key={p.key} width={p.width} flexDirection="column">
      <Box flexDirection="column" borderStyle="round" borderColor={t.border} backgroundColor={t.surface} paddingX={2} paddingY={1} gap={1}>
        {p.description !== undefined ? <Text color={t.muted}>{p.description}</Text> : null}
        {p.children}
        {p.footer !== undefined ? (
          <Box flexDirection="column">
            {Separator(el, t)}
            <Box marginTop={0}>{p.footer}</Box>
          </Box>
        ) : null}
      </Box>
      <Box position="absolute" top={0} left={2} backgroundColor={t.bg}>
        <Text bold color={t.text}> {p.title} </Text>
      </Box>
    </Box>
  )
}

export type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive' | 'success'

export function Badge(el: ElementTable, t: Theme, p: { label: string; variant?: BadgeVariant; key?: string }) {
  const { Text, Box } = el
  const v = p.variant ?? 'default'
  if (v === 'outline') {
    return (
      <Box key={p.key} flexDirection="row">
        <Text color={t.borderStrong}>▏</Text>
        <Text color={t.text}>{p.label}</Text>
        <Text color={t.borderStrong}>▕</Text>
      </Box>
    )
  }
  const bg = v === 'secondary' ? t.surfaceHover : v === 'destructive' ? t.danger : v === 'success' ? t.success : t.accent
  const fg = v === 'secondary' ? t.text : v === 'default' ? t.accentText : contrast(bg)

  return (
    <Box key={p.key} flexDirection="row">
      <Text color={bg}>▐</Text>
      <Text backgroundColor={bg} color={fg} bold>{p.label}</Text>
      <Text color={bg}>▌</Text>
    </Box>
  )
}

/** Pressable pill: selected = primary, else secondary. */
export function Chip(el: ElementTable, t: Theme, p: { label: string; selected?: boolean; onPress: () => void; key: string; surface?: RenderSurface }) {
  return Btn(el, t, { label: p.label, variant: p.selected === true ? 'primary' : 'secondary', size: 'sm', pill: true, onPress: p.onPress, key: p.key, surface: p.surface })
}

export type TabsProps = {
  tabs: readonly { id: string; label: string }[]
  selected: string
  onSelect: (id: string) => void
  style?: 'underline' | 'pill'
  surface?: RenderSurface
  keyPrefix?: string // Button keys are `<prefix>:<id>`, default `tab`; unique per drawing
}

/** Tab strip; each tab's Button key is `<keyPrefix ?? 'tab'>:<id>`. */
export function Tabs(el: ElementTable, t: Theme, p: TabsProps) {
  const { Box, Text, Button } = el
  const pre = p.keyPrefix ?? 'tab'
  if (!isTerminal(p.surface)) {
    return (
      <Box flexDirection="row" gap={1}>
        {p.tabs.map(tab => (
          <Button key={pre + ':' + tab.id} label={tab.label} variant={tab.id === p.selected ? 'primary' : 'secondary'} onPress={() => p.onSelect(tab.id)} />
        ))}
      </Box>
    )
  }
  if (p.style === 'pill') {
    return (
      <Box flexDirection="row" backgroundColor={onDefaultFg(t.surface)} alignSelf="flex-start">
        {p.tabs.map(tab => {
          const on = tab.id === p.selected

          return (
            <Box key={pre + ':' + tab.id + ':chrome'} backgroundColor={on ? onDefaultFg(t.accent) : undefined} paddingX={1} hover={on ? undefined : { backgroundColor: onDefaultFg(t.surfaceHover) }}>
              <Button key={pre + ':' + tab.id} plain label={tab.label} onPress={() => p.onSelect(tab.id)} />
            </Box>
          )
        })}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" gap={0}>
      {p.tabs.map(tab => {
        const on = tab.id === p.selected
        const w = tab.label.length + 4

        return (
          <Box key={pre + ':' + tab.id + ':chrome'} flexDirection="column" hover={on ? undefined : { backgroundColor: onDefaultFg(t.surface) }}>
            <Box paddingX={2} backgroundColor={chromeBg(t)}>
              <Button key={pre + ':' + tab.id} plain label={tab.label} hover={{ underline: true }} onPress={() => p.onSelect(tab.id)} />
            </Box>
            <Text color={on ? t.accent : t.border}>{(on ? '━' : '─').repeat(w)}</Text>
          </Box>
        )
      })}
    </Box>
  )
}

export type ProgressProps = { value: number; width?: number; color?: string; showPercent?: boolean; label?: string; key?: string }

export function Progress(el: ElementTable, t: Theme, p: ProgressProps) {
  const { Box, Text } = el
  const width = p.width ?? 24
  const pct = Math.round(Math.min(1, Math.max(0, p.value)) * 100)

  return (
    <Box key={p.key} flexDirection="row" gap={1}>
      {p.label !== undefined ? <Text color={t.muted}>{p.label}</Text> : null}
      <Text color={p.color ?? t.accent} backgroundColor={t.border}>{barString(p.value, width)}</Text>
      {p.showPercent !== false ? <Text color={t.muted}>{String(pct).padStart(3)}%</Text> : null}
    </Box>
  )
}

const ICONS: Record<Tone, string> = { info: 'ℹ', success: '✓', warning: '⚠', destructive: '✕' }

export function Alert(el: ElementTable, t: Theme, p: { tone: Tone; title: string; description?: string; key?: string }) {
  const { Box, Text } = el
  const c = tone(t, p.tone)

  return (
    <Box key={p.key} flexDirection="row" backgroundColor={t.surface}>
      <Box width={1} backgroundColor={c} />
      <Box flexDirection="column" paddingX={1} paddingY={0}>
        <Text bold color={c}>{ICONS[p.tone]} {p.title}</Text>
        {p.description !== undefined ? <Text color={t.muted}>{p.description}</Text> : null}
      </Box>
    </Box>
  )
}

export function Kbd(el: ElementTable, t: Theme, p: { keys: string; key?: string }) {
  const { Text } = el

  return <Text key={p.key} backgroundColor={t.surfaceHover} color={t.text}> {p.keys} </Text>
}

const AVATAR_COLORS = (t: Theme): string[] => [t.accent, t.info, t.success, t.warning, t.danger]

export function Avatar(el: ElementTable, t: Theme, p: { name: string; color?: string; key?: string }) {
  const { Box, Text } = el
  let hash = 0
  for (const ch of p.name) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  const colors = AVATAR_COLORS(t)
  const c = p.color ?? (colors[hash % colors.length] as string)

  return (
    <Box key={p.key} flexDirection="row">
      <Text color={c}>▐</Text>
      <Text backgroundColor={c} color={contrast(c)} bold>{initials(p.name)}</Text>
      <Text color={c}>▌</Text>
    </Box>
  )
}

export function Skeleton(el: ElementTable, t: Theme, p: { width?: number; rows?: number; key?: string }) {
  const { Box, Text } = el
  const w = p.width ?? 20

  return (
    <Box key={p.key} flexDirection="column">
      {Array.from({ length: p.rows ?? 1 }, (_, i) => (
        <Text key={'sk' + i} color={t.border}>{'░'.repeat(i === 0 ? w : Math.max(1, Math.round(w * 0.7)))}</Text>
      ))}
    </Box>
  )
}

/* ---- Form components (A3). Pure, same style; Button keys are the `key` given, once per drawing. ---- */

/** Terminal: a colored glyph Text beside a plain Button carrying the label; native Button elsewhere. */
function Pressable(el: ElementTable, t: Theme, p: { key: string; glyph: string; color: string; label: string; onPress: () => void; surface?: RenderSurface }) {
  const { Box, Text, Button } = el
  if (!isTerminal(p.surface)) return <Button key={p.key} label={`${p.glyph} ${p.label}`} onPress={p.onPress} />

  return (
    <Box key={p.key + ':chrome'} flexDirection="row" flexShrink={0} backgroundColor={chromeBg(t)}>
      <Text color={p.color}>{p.glyph}</Text>
      <Button key={p.key} plain label={' ' + p.label} hover={{ underline: true }} onPress={p.onPress} />
    </Box>
  )
}

export type FieldProps = {
  label: string
  children?: RenderChildren // the native Input / Select
  helper?: string
  error?: string
  valid?: boolean // filled and valid: accent frame
  key?: string
  required?: boolean
}

/**
 * Field anatomy: bold label, a round frame around the control (danger when `error`, accent when `valid`),
 * muted helper, danger error text (replaces the helper).
 */
export function Field(el: ElementTable, t: Theme, p: FieldProps) {
  const { Box, Text } = el
  const frame = p.error !== undefined ? t.danger : p.valid === true ? t.accent : t.border

  return (
    <Box key={p.key} flexDirection="column">
      <Text bold color={t.text}>{p.label}{p.required === true ? <Text color={t.danger}> *</Text> : null}</Text>
      <Box borderStyle="round" borderColor={frame} backgroundColor={t.bg} paddingX={1}>
        {p.children}
      </Box>
      {p.error !== undefined ? <Text color={t.danger}>✕ {p.error}</Text> : p.helper !== undefined ? <Text color={t.muted}>{p.helper}</Text> : null}
    </Box>
  )
}

export type TextFieldProps = {
  key: string // the Input's key
  label: string
  value: string
  placeholder?: string
  helper?: string
  error?: string
  valid?: boolean
  required?: boolean
  onInput: (value: string) => void
  onSubmit?: (value: string) => void
  submitLabel?: string
  surface?: RenderSurface
}

/** Field around a native Input (terminal, desktop, vscode). */
export function TextField(el: ElementTable<'terminal' | 'desktop' | 'vscode'>, t: Theme, p: TextFieldProps) {
  const { Input } = el

  return Field(el, t, {
    key: p.key + ':field',
    label: p.label,
    helper: p.helper,
    error: p.error,
    valid: p.valid,
    required: p.required,
    children: <Input key={p.key} placeholder={p.placeholder} value={p.value} submitLabel={p.submitLabel} onInput={p.onInput} onSubmit={p.onSubmit ?? p.onInput} />,
  })
}

export type SelectFieldProps = {
  key: string // the Select's key
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  helper?: string
  error?: string
  onSelect: (value: string) => void
}

/** Field around a native Select. */
export function SelectField(el: ElementTable<'terminal' | 'desktop' | 'vscode'>, t: Theme, p: SelectFieldProps) {
  const { Select } = el

  return Field(el, t, {
    key: p.key + ':field',
    label: p.label,
    helper: p.helper,
    error: p.error,
    children: <Select key={p.key} options={p.options} value={p.value} onSelect={p.onSelect} />,
  })
}

/** `☑ label` / `☐ label`; Button key = `key`. */
export function Checkbox(el: ElementTable, t: Theme, p: { key: string; label: string; checked: boolean; onChange: (next: boolean) => void; error?: boolean; surface?: RenderSurface }) {
  const glyph = p.checked ? '☑' : '☐'

  return Pressable(el, t, { key: p.key, glyph, color: p.error === true ? t.danger : p.checked ? t.accent : t.text, label: p.label, onPress: () => p.onChange(!p.checked), surface: p.surface })
}

/** Vertical or horizontal radio group, `◉` / `○`; each Button key is `<key>:<option value>`. */
/** Radio options in a row or a column; a `disabled` one is muted text, no Button: it cannot be pressed or focused. */
export function RadioGroup(el: ElementTable, t: Theme, p: { key: string; options: readonly { value: string; label: string; disabled?: boolean }[]; value: string; onChange: (v: string) => void; row?: boolean; surface?: RenderSurface }) {
  const { Box, Text } = el

  return (
    // A row wraps where it runs out of room (no row gap), never squeezing a glyph away.
    <Box key={p.key} flexDirection={p.row === true ? 'row' : 'column'} flexWrap={p.row === true ? 'wrap' : 'nowrap'} columnGap={p.row === true ? 2 : 0}>
      {p.options.map(o => {
        const on = o.value === p.value

        if (o.disabled === true) {
          return (
            <Box key={p.key + ':' + o.value + ':off'} flexDirection="row" flexShrink={0}>
              <Text color={t.muted}>{(on ? '◉' : '○') + ' ' + o.label}</Text>
            </Box>
          )
        }

        return Pressable(el, t, { key: p.key + ':' + o.value, glyph: on ? '◉' : '○', color: on ? t.accent : t.text, label: o.label, onPress: () => p.onChange(o.value), surface: p.surface })
      })}
    </Box>
  )
}

/** Toggle pill: `●━━` off (muted), `━━●` on (accent), then the label; Button key = `key`. */
export function Switch(el: ElementTable, t: Theme, p: { key: string; label: string; on: boolean; onChange: (next: boolean) => void; surface?: RenderSurface }) {

  return Pressable(el, t, { key: p.key, glyph: p.on ? '━━●' : '●━━', color: p.on ? t.accent : t.muted, label: p.label, onPress: () => p.onChange(!p.on), surface: p.surface })
}

// ---- Overlays (appended by A4): Modal, ModalBtn, DropdownMenu, Tooltip ----
// Findings: an overlay must be the LAST child of an UNBORDERED wrapper (draw order is z-order, a
// bordered Box clips its children). Absolute Boxes take numeric top/left; overlays that open
// downward must have blank room reserved in the flow (later siblings paint over them).
import { cardHeight, cardWidth, darken, menuSize, modalBox, wrapText } from './overlay'

export type ModalBtnProps = {
  key: string
  label: string
  variant: 'ghost' | 'primary' | 'danger'
  onPress: () => void
  dismiss?: boolean // role: 'dismiss'
  autoFocus?: boolean
  surface?: RenderSurface
}

/** Footer button of a modal: like Btn, plus `autoFocus` and the dismiss role. */
export function ModalBtn(el: ElementTable, t: Theme, p: ModalBtnProps) {
  const { Box, Text, Button } = el
  if (!isTerminal(p.surface)) {
    return (
      <Button
        key={p.key}
        label={p.label}
        variant={p.variant === 'primary' ? 'primary' : undefined}
        role={p.dismiss === true ? 'dismiss' : undefined}
        autoFocus={p.autoFocus === true ? true : undefined}
        onPress={p.onPress}
      />
    )
  }
  const bg = p.variant === 'primary' ? onDefaultFg(t.accent) : p.variant === 'danger' ? onDefaultFg(t.danger) : chromeBg(t)

  return (
    <Box key={p.key + ':chrome'} backgroundColor={bg} paddingX={1} hover={{ backgroundColor: bg ?? onDefaultFg(t.surfaceHover) }}>
      <Button key={p.key} plain label={p.label} role={p.dismiss === true ? 'dismiss' : undefined} autoFocus={p.autoFocus === true ? true : undefined} onPress={p.onPress} />
    </Box>
  )
}

export type ModalProps = {
  key: string
  title: string
  body: string
  cols: number // pane body columns
  rows: number // pane body rows
  footer: RenderChildren // ModalBtn elements
  destructive?: boolean
}

/** Backdrop + shadow + centered card, all absolute: draw it LAST in an unbordered wrapper. */
export function Modal(el: ElementTable, t: Theme, p: ModalProps) {
  const { Box, Text } = el
  const cardW = cardWidth(p.cols)
  const lines = wrapText(p.body, cardW - 6)
  const cardH = cardHeight(lines.length)
  const pos = modalBox(p.cols, p.rows, cardW, cardH)
  const dim = darken(t.bg, 0.55)

  return (
    <Box key={p.key} position="absolute" top={0} left={0} width={p.cols} height={Math.max(p.rows, cardH + 2)}>
      <Box position="absolute" top={0} left={0} width={p.cols} height={Math.max(p.rows, cardH + 2)} backgroundColor={dim} />
      <Box position="absolute" top={pos.shadowTop} left={pos.shadowLeft} width={cardW} height={cardH} backgroundColor={darken(t.bg, 0.85)} />
      <Box position="absolute" top={pos.top} left={pos.left} width={cardW} height={cardH} flexDirection="column" borderStyle="round" borderColor={p.destructive === true ? t.danger : t.borderStrong} backgroundColor={t.surface} paddingX={2} paddingY={1} gap={1}>
        <Text bold color={p.destructive === true ? t.danger : t.text}>{p.title}</Text>
        <Box flexDirection="column">
          {lines.map((l, i) => (
            <Text key={'ml' + i} color={t.muted}>{l}</Text>
          ))}
        </Box>
        <Box flexDirection="row" justifyContent="flex-end" gap={1}>{p.footer}</Box>
      </Box>
    </Box>
  )
}

export type MenuItem = { key: string; label: string; icon?: string; kbd?: string; destructive?: boolean; separator?: boolean }

export type DropdownMenuProps = {
  key: string
  items: readonly MenuItem[]
  onSelect: (key: string) => void
  top: number // offset in the (unbordered) wrapper the trigger sits in
  left: number
  surface?: RenderSurface
  scope?: string // given: drawn display none, revealed by hover of the same scope (no hook, no press needed)
}

/** Absolute popover: round border, rows with icon + label + shortcut; a separator is an item with `separator`. */
export function DropdownMenu(el: ElementTable, t: Theme, p: DropdownMenuProps) {
  const { Box, Text, Button } = el
  const size = menuSize(p.items)
  const inner = size.width - 4
  const rows = p.items.map(it => {
    if (it.separator === true) return <Text key={p.key + ':sep:' + it.key} color={t.border}>{'─'.repeat(inner)}</Text>
    if (!isTerminal(p.surface)) return <Button key={p.key + ':' + it.key} label={(it.icon !== undefined ? it.icon + ' ' : '') + it.label + (it.kbd !== undefined ? '  ' + it.kbd : '')} onPress={() => p.onSelect(it.key)} />
    const kbd = it.kbd ?? ''
    const pad = Math.max(1, inner - 2 - it.label.length - kbd.length)

    return (
      <Box key={p.key + ':' + it.key + ':chrome'} width={inner} flexDirection="row" hover={{ backgroundColor: onDefaultFg(t.surfaceHover) }}>
        <Text color={it.destructive === true ? t.danger : t.text}>{it.icon ?? ' '}</Text>
        <Button key={p.key + ':' + it.key} plain label={' ' + it.label + ' '.repeat(pad) + kbd} onPress={() => p.onSelect(it.key)} />
      </Box>
    )
  })

  return (
    <Box
      key={p.key}
      position="absolute"
      top={p.top}
      left={p.left}
      width={size.width}
      flexDirection="column"
      borderStyle="round"
      borderColor={t.borderStrong}
      backgroundColor={isTerminal(p.surface) ? (chromeBg(t) ?? t.surface) : t.surface}
      paddingX={1}
      display={p.scope !== undefined ? 'none' : undefined}
      hover={p.scope !== undefined ? { scope: p.scope, display: 'flex' } : undefined}
    >
      {rows}
    </Box>
  )
}

export type TooltipProps = { scope: string; text: string; top: number; left: number; key?: string }

/** Hover-revealed card. The trigger must be a Box whose `hover` carries the same `scope` (see TooltipTrigger). */
export function Tooltip(el: ElementTable, t: Theme, p: TooltipProps) {
  const { Box, Text } = el

  return (
    <Box key={p.key} position="absolute" top={p.top} left={p.left} display="none" hover={{ scope: p.scope, display: 'flex' }} borderStyle="round" borderColor={t.borderStrong} backgroundColor={t.surface} paddingX={1}>
      <Text color={t.text}>{p.text}</Text>
    </Box>
  )
}

/** Wrapper that makes `children` the hover source of `scope` (lights faintly). */
export function TooltipTrigger(el: ElementTable, t: Theme, p: { scope: string; children: RenderChildren; key?: string }) {
  const { Box } = el

  return (
    <Box key={p.key} hover={{ scope: p.scope, backgroundColor: t.surfaceHover }}>
      {p.children}
    </Box>
  )
}
