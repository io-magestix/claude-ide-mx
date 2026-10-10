/*
 * The Settings sheet and the Settings Button, drawn by both panels: pure (el, theme,
 * props) -> tree; every `$` call stays in the panel's index.tsx, which passes
 * the values and the callbacks.
 *
 * Settings sits at the right end of the panel's title row (body row 0), under the
 * pane's close ✕: the ✕ row is the engine's frame (it closes the pane; the
 * plugin cannot hide it), and a Box placed above the body (`top={-1}`) is not
 * drawn.
 *
 * The sheet is an overlay drawn LAST in the panel's unbordered root column:
 * a dimmed backdrop from row 1 (the title row and its Settings Button stay pressable) and a
 * centered card. Every Button key starts `settings:`.
 */
import type { ElementTable, RenderChildren, RenderSurface } from 'claude-code'

import type { SettingsState } from '../../types'
import { centerOffset, darken } from './overlay'
import { DEFAULTS, GIT_LIMITS } from './settings'
import type { Theme } from './theme'
import { Btn, Chip, Field, ModalBtn, RadioGroup, Switch } from './ui'

type FileIcons = NonNullable<SettingsState['fileIcons']>

// The Settings Button's key.
const SETTINGS_BUTTON = 'settings'

/**
 * The title row's right end: `Settings` (pressed on the open sheet = done), a
 * ghost Btn.
 */
export function PaneButtons(
  el: ElementTable,
  t: Theme,
  p: { surface?: RenderSurface; isOpen: boolean; onSettings: () => void },
) {
  const { Box } = el
  return (
    <Box key="pane-buttons" flexDirection="row" gap={1}>
      {Btn(el, t, { key: SETTINGS_BUTTON, label: 'Settings', variant: p.isOpen ? 'primary' : 'ghost', surface: p.surface, onPress: p.onSettings })}
    </Box>
  )
}

type SheetProps = {
  surface?: RenderSurface
  cols: number // the panel body's columns
  rows: number // the panel body's rows
  settings: SettingsState
  keymap: 'jetbrains' | 'vscode' // the preset in effect (settings, else userConfig)
  fileIcons: FileIcons // the icons in effect (settings, else by the terminal font)
  keys: string // the overrides field's text
  keysError?: string
  onChange: (patch: Partial<SettingsState>) => void
  onKeys: (text: string) => void
  onResetLayout: () => void
  onDone: () => void
  onCancel: () => void
}

// Columns of the label before each control.
const LABEL = 14

/** The card's width in a panel `cols` wide: up to 76, 2 cells of backdrop a side. */
const sheetWidth = (cols: number): number => Math.max(24, Math.min(76, cols - 4))

/** The Settings sheet: backdrop + card, absolute; draw it last in an unbordered column. */
export function SettingsSheet(el: ElementTable, t: Theme, p: SheetProps) {
  const { Box, Text } = el
  const s = p.settings
  const surface = p.surface
  const cardW = sheetWidth(p.cols)
  // The card's rows as drawn below (frame 2, title, 5 headings, 8 rows, the
  // keys field 5, separator, footer): centers it; a wrapped row adds one,
  // which the shadow follows by itself.
  const cardH = 2 + 1 + 5 + 8 + 5 + 1 + 1
  const area = Math.max(1, p.rows - 1)
  const top = centerOffset(area, cardH + 1)
  const left = centerOffset(p.cols, cardW + 1)

  const heading = (key: string, text: string) => (
    <Text key={key} bold color={t.accent}>
      {text}
    </Text>
  )
  const line = (key: string, label: string, control: RenderChildren) => (
    <Box key={key} flexDirection="row">
      <Box width={LABEL} flexShrink={0}>
        <Text color={t.muted}>{label}</Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={1}>
        {control}
      </Box>
    </Box>
  )
  const radio = (key: string, value: string, options: readonly (readonly [string, string])[], onChange: (v: string) => void) =>
    RadioGroup(el, t, { key, value, surface, options: options.map(([v, label]) => ({ value: v, label })), onChange })

  const limit = s.gitLimit ?? DEFAULTS.gitLimit
  // The overrides field: a native Input where the surface has one (not mobile).
  const Input = 'Input' in el ? el.Input : undefined
  const keysField = Field(el, t, {
    key: 'settings:keys:field',
    label: 'Key overrides (JSON, over the preset)',
    error: p.keysError,
    helper: p.keysError === undefined ? 'e.g. {"duplicateLines":"ctrl+shift+d"}' : undefined,
    children:
      Input !== undefined ? (
        <Input key="settings:keys" placeholder="{}" value={p.keys} submitLabel="Apply" onInput={p.onKeys} onSubmit={p.onKeys} />
      ) : (
        <Text color={t.muted} wrap="truncate-end">
          {p.keys === '' ? '(none; edit on the terminal or desktop)' : p.keys}
        </Text>
      ),
  })

  return (
    <Box key="settings:sheet" position="absolute" top={1} left={0} width={p.cols} height={Math.max(area, cardH + 1)}>
      <Box position="absolute" top={0} left={0} width={p.cols} height={Math.max(area, cardH + 1)} backgroundColor={darken(t.bg, 0.55)} />
      {/* Card and shadow share an unbordered wrapper as tall as the card as
          laid out: the shadow, one cell down and right and drawn first, takes
          the wrapper's height, so a wrapped row grows both alike. */}
      <Box position="absolute" top={top} left={left} width={cardW + 1} flexDirection="column">
        <Box position="absolute" top={1} left={1} width={cardW} height="100%" backgroundColor={darken(t.bg, 0.85)} />
        <Box
          width={cardW}
          flexDirection="column"
          borderStyle="round"
          borderColor={t.borderStrong}
          backgroundColor={t.surface}
          paddingX={2}
        >
          <Text bold color={t.text}>
            Settings
          </Text>
          {heading('settings:h:appearance', 'Appearance')}
          {line(
            'settings:l:accent',
            'Accent',
            Switch(el, t, {
              key: 'settings:accent',
              label: 'From /color',
              on: s.accentFromSession ?? DEFAULTS.accentFromSession,
              surface,
              onChange: on => p.onChange({ accentFromSession: on }),
            }),
          )}
          {heading('settings:h:editor', 'Editor')}
          {line('settings:l:keymap', 'Keymap', radio('settings:keymap', p.keymap, [['jetbrains', 'JetBrains'], ['vscode', 'VS Code']], v => p.onChange({ keymap: v as 'jetbrains' | 'vscode' })))}
          {keysField}
          {heading('settings:h:explorer', 'Explorer')}
          {line(
            'settings:l:mode',
            'Default mode',
            radio('settings:mode', s.explorerMode ?? DEFAULTS.explorerMode, [['files', 'Files'], ['unity', 'Unity']], v => p.onChange({ explorerMode: v as 'files' | 'unity' })),
          )}
          {line(
            'settings:l:icons',
            'File icons',
            radio('settings:icons', p.fileIcons, [['off', 'Off'], ['nerd', 'Nerd Font'], ['basic', 'Basic']], v => p.onChange({ fileIcons: v as FileIcons })),
          )}
          {heading('settings:h:git', 'Git')}
          {line(
            'settings:l:tab',
            'Default tab',
            radio('settings:tab', s.gitTab ?? DEFAULTS.gitTab, [['overview', 'Overview'], ['graph', 'Graph'], ['changelog', 'Change Log']], v =>
              p.onChange({ gitTab: v as 'overview' | 'graph' | 'changelog' }),
            ),
          )}
          {line(
            'settings:l:limit',
            'Commits/page',
            GIT_LIMITS.map(n =>
              Chip(el, t, { key: 'settings:limit:' + n, label: String(n), selected: n === limit, surface, onPress: () => p.onChange({ gitLimit: n }) }),
            ),
          )}
          {heading('settings:h:layout', 'Layout')}
          {line(
            'settings:l:auto',
            'Session',
            Switch(el, t, {
              key: 'settings:autoOpen',
              label: 'Open on start, close on exit',
              on: s.autoOpen ?? DEFAULTS.autoOpen,
              surface,
              onChange: on => p.onChange({ autoOpen: on }),
            }),
          )}
          {line('settings:l:reset', 'Sections', [
            Btn(el, t, { key: 'settings:reset', label: 'Reset Layout', variant: 'danger', surface, onPress: p.onResetLayout }),
            <Text key="settings:reset:hint" color={t.muted}>
              sizes back to defaults, now
            </Text>,
          ])}
          <Text color={t.border} wrap="truncate-end">
            {'─'.repeat(Math.max(1, cardW - 6))}
          </Text>
          <Box flexDirection="row" justifyContent="flex-end" gap={1}>
            {ModalBtn(el, t, { key: 'settings:cancel', label: 'Cancel', variant: 'ghost', dismiss: true, surface, onPress: p.onCancel })}
            {ModalBtn(el, t, { key: 'settings:done', label: 'Done', variant: 'primary', surface, onPress: p.onDone })}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
