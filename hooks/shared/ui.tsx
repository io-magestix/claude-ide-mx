/*
 * Component library of the panels: pure functions (el, theme, props) -> tree.
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
 *   that foreground); ghost has no fill on a dark theme. On a light theme (bg
 *   luminance > 0.5) the page is white while labels stay light, so `chromeBg` gives those
 *   controls a darkened-surface fill. Colored glyphs (radio, switch track, pill caps)
 *   are a separate Text BESIDE the Button, never under it. Button `hover` (underline) works
 *   inside the keyed chrome Box. Desktop/vscode/mobile get a native Button.
 * - Keyed Box + `hover` ({ backgroundColor, borderColor }) and Text `hover` ({ color })
 *   validate (kit-verified); no hook runs. Hover on a Text/Button needs an enclosing keyed Box.
 * - Hex colors validate everywhere (theme tokens are raw hex).
 * - Section titles: a bordered Box clips its children, so the title is an absolute Box
 *   (top=0) after the bordered Box inside an unbordered wrapper.
 * - Pill caps are half blocks: `▐` (left cap) and `▌` (right cap) in the fill color.
 */
import type { ElementTable, RenderChildren, RenderSurface } from 'claude-code'

import type { Theme } from './theme'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const isTerminal = (surface: RenderSurface | undefined): boolean => (surface ?? 'terminal') === 'terminal'

const rgb = (hex: string): [number, number, number] | undefined => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (m === null) return undefined
  const n = parseInt(m[1] as string, 16)

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** '#000000' or '#ffffff', whichever reads on `hex`. */
export function contrast(hex: string): string {
  const c = rgb(hex)
  if (c === undefined) return '#ffffff'
  const [r, g, b] = c

  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#000000' : '#ffffff'
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

export type BtnProps = {
  label: string
  variant?: Variant
  pill?: boolean
  onPress: () => void
  key: string
  surface?: RenderSurface
}

/**
 * Styled one-row button. Terminal: keyed Box chrome (bg, hover) around a plain Button
 * carrying the label. Other surfaces: the native Button.
 */
export function Btn(el: ElementTable, t: Theme, p: BtnProps) {
  const { Box, Text, Button } = el
  const variant = p.variant ?? 'secondary'
  if (!isTerminal(p.surface)) {
    return <Button key={p.key} label={p.label} variant={variant === 'primary' ? 'primary' : variant === 'secondary' ? 'secondary' : undefined} onPress={p.onPress} />
  }

  const fill = {
    primary: { bg: onDefaultFg(t.accent), hover: onDefaultFg(t.accentHover) },
    secondary: { bg: onDefaultFg(t.surface), hover: onDefaultFg(t.surfaceHover) },
    ghost: { bg: chromeBg(t), hover: onDefaultFg(t.surfaceHover) },
    danger: { bg: onDefaultFg(t.danger), hover: onDefaultFg(t.danger) },
  }[variant]
  const label = (
    <Button key={p.key} plain label={p.label} hover={{ underline: true }} onPress={p.onPress} />
  )

  if (p.pill) {
    const cap = fill.bg ?? onDefaultFg(t.surface)
    return (
      <Box key={p.key + ':chrome'} flexDirection="row">
        <Text color={cap} hover={{ color: fill.hover }}>▐</Text>
        <Box backgroundColor={cap} hover={{ backgroundColor: fill.hover }}>{label}</Box>
        <Text color={cap} hover={{ color: fill.hover }}>▌</Text>
      </Box>
    )
  }

  return (
    <Box key={p.key + ':chrome'} backgroundColor={fill.bg} paddingX={1} hover={{ backgroundColor: fill.hover }}>
      {label}
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
  return Btn(el, t, { label: p.label, variant: p.selected === true ? 'primary' : 'secondary', pill: true, onPress: p.onPress, key: p.key, surface: p.surface })
}

export type TabsProps = {
  tabs: readonly { id: string; label: string }[]
  selected: string
  onSelect: (id: string) => void
  surface?: RenderSurface
  gap: number // cells between tabs
}

/** Tab strip: on the terminal, pills set apart, each with its own fill. Each tab's Button key is `tab:<id>`. */
export function Tabs(el: ElementTable, t: Theme, p: TabsProps) {
  const { Box, Button } = el
  if (!isTerminal(p.surface)) {
    return (
      <Box flexDirection="row" gap={p.gap}>
        {p.tabs.map(tab => (
          <Button key={'tab:' + tab.id} label={tab.label} variant={tab.id === p.selected ? 'primary' : 'secondary'} onPress={() => p.onSelect(tab.id)} />
        ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="row" alignSelf="flex-start" gap={p.gap}>
      {p.tabs.map(tab => {
        const on = tab.id === p.selected

        return (
          <Box key={'tab:' + tab.id + ':chrome'} backgroundColor={onDefaultFg(on ? t.accent : t.surface)} paddingX={1} hover={on ? undefined : { backgroundColor: onDefaultFg(t.surfaceHover) }}>
            <Button key={'tab:' + tab.id} plain label={tab.label} onPress={() => p.onSelect(tab.id)} />
          </Box>
        )
      })}
    </Box>
  )
}

/* ---- Form components. Pure, same style; Button keys are the `key` given, once per drawing. ---- */

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
  children?: RenderChildren // the native Input
  helper?: string
  error?: string
  key?: string
}

/**
 * Field anatomy: bold label, a round frame around the control (danger when `error`),
 * muted helper, danger error text (replaces the helper).
 */
export function Field(el: ElementTable, t: Theme, p: FieldProps) {
  const { Box, Text } = el

  return (
    <Box key={p.key} flexDirection="column">
      <Text bold color={t.text}>{p.label}</Text>
      <Box borderStyle="round" borderColor={p.error !== undefined ? t.danger : t.border} backgroundColor={t.bg} paddingX={1}>
        {p.children}
      </Box>
      {p.error !== undefined ? <Text color={t.danger}>✕ {p.error}</Text> : p.helper !== undefined ? <Text color={t.muted}>{p.helper}</Text> : null}
    </Box>
  )
}

/** Radio options in a row, `◉` / `○`; each Button key is `<key>:<option value>`. */
export function RadioGroup(el: ElementTable, t: Theme, p: { key: string; options: readonly { value: string; label: string }[]; value: string; onChange: (v: string) => void; surface?: RenderSurface }) {
  const { Box } = el

  return (
    // The row wraps where it runs out of room (no row gap), never squeezing a glyph away.
    <Box key={p.key} flexDirection="row" flexWrap="wrap" columnGap={2}>
      {p.options.map(o => {
        const on = o.value === p.value

        return Pressable(el, t, { key: p.key + ':' + o.value, glyph: on ? '◉' : '○', color: on ? t.accent : t.text, label: o.label, onPress: () => p.onChange(o.value), surface: p.surface })
      })}
    </Box>
  )
}

/** Toggle pill: `●━━` off (muted), `━━●` on (accent), then the label; Button key = `key`. */
export function Switch(el: ElementTable, t: Theme, p: { key: string; label: string; on: boolean; onChange: (next: boolean) => void; surface?: RenderSurface }) {

  return Pressable(el, t, { key: p.key, glyph: p.on ? '━━●' : '●━━', color: p.on ? t.accent : t.muted, label: p.label, onPress: () => p.onChange(!p.on), surface: p.surface })
}

// ---- Overlays: ModalBtn, the footer button of an overlay card (the Settings sheet) ----
// Findings: an overlay must be the LAST child of an UNBORDERED wrapper (draw order is z-order, a
// bordered Box clips its children). Absolute Boxes take numeric top/left; overlays that open
// downward must have blank room reserved in the flow (later siblings paint over them).
export type ModalBtnProps = {
  key: string
  label: string
  variant: 'ghost' | 'primary'
  onPress: () => void
  dismiss?: boolean // role: 'dismiss'
  surface?: RenderSurface
}

/** Footer button of a modal: like Btn, plus the dismiss role. */
export function ModalBtn(el: ElementTable, t: Theme, p: ModalBtnProps) {
  const { Box, Button } = el
  if (!isTerminal(p.surface)) {
    return (
      <Button
        key={p.key}
        label={p.label}
        variant={p.variant === 'primary' ? 'primary' : undefined}
        role={p.dismiss === true ? 'dismiss' : undefined}
        onPress={p.onPress}
      />
    )
  }
  const bg = p.variant === 'primary' ? onDefaultFg(t.accent) : chromeBg(t)

  return (
    <Box key={p.key + ':chrome'} backgroundColor={bg} paddingX={1} hover={{ backgroundColor: bg ?? onDefaultFg(t.surfaceHover) }}>
      <Button key={p.key} plain label={p.label} role={p.dismiss === true ? 'dismiss' : undefined} onPress={p.onPress} />
    </Box>
  )
}
