// Pure helpers for the Settings values (`$.state` `settings`, `$.store`
// `settings`): defaults, the store reader, the resolved theme and keymap.
import type { GitState, SettingsState } from '../../types'
import { KEYMAPS, mergeKeymap } from '../explorer-panel/editor'
import type { Keymap } from '../explorer-panel/editor'
import { sessionHex } from './color'
import { THEMES } from './theme'
import { themeFromClaudeCode, themeFromScheme } from './term-theme'
import type { TermScheme } from './term-theme'
import type { Theme } from './theme'
import { contrast } from './ui'

// The `$.store` key, global (every root and session).
export const SETTINGS_KEY = 'settings'

// Every field's value while it is absent; `keymap` is absent here as its
// default is userConfig `editorKeymap` (see mergeKeys).
export const DEFAULTS = {
  theme: 'claude' as 'claude' | 'terminal' | 'claude-code',
  accentFromSession: true,
  explorerMode: 'files' as 'files' | 'unity',
  gitTab: 'overview' as 'overview' | 'graph' | 'changelog',
  gitLimit: 200,
  autoOpen: true,
} as const

const oneOf = <T extends string>(value: unknown, all: readonly T[]): T | undefined =>
  typeof value === 'string' && (all as readonly string[]).includes(value) ? (value as T) : undefined

// A stored value as SettingsState: unknown or ill-typed fields are dropped;
// anything but an object is undefined.
export const settingsOf = (raw: unknown): SettingsState | undefined => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const out: SettingsState = {}
  const theme = oneOf(r.theme, ['claude', 'terminal', 'claude-code'] as const)
  if (theme !== undefined) out.theme = theme
  if (typeof r.accentFromSession === 'boolean') out.accentFromSession = r.accentFromSession
  const keymap = oneOf(r.keymap, ['jetbrains', 'vscode'] as const)
  if (keymap !== undefined) out.keymap = keymap
  if (typeof r.keys === 'string') out.keys = r.keys
  const explorerMode = oneOf(r.explorerMode, ['files', 'unity'] as const)
  if (explorerMode !== undefined) out.explorerMode = explorerMode
  const gitTab = oneOf(r.gitTab, ['overview', 'graph', 'changelog'] as const)
  if (gitTab !== undefined) out.gitTab = gitTab
  if (typeof r.gitLimit === 'number' && Number.isInteger(r.gitLimit) && r.gitLimit > 0) out.gitLimit = r.gitLimit
  if (typeof r.autoOpen === 'boolean') out.autoOpen = r.autoOpen

  return out
}

// '#rrggbb' moved toward white by `amount` (0..1); other strings unchanged.
const lighten = (hex: string, amount: number): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (m === null) return hex
  const n = parseInt(m[1] as string, 16)
  const k = Math.min(1, Math.max(0, amount))
  const c = (v: number) => Math.round(v + (255 - v) * k).toString(16).padStart(2, '0')

  return '#' + c((n >> 16) & 255) + c((n >> 8) & 255) + c(n & 255)
}

// The theme the panels draw with: the Settings `theme` (`terminal` from the
// terminal's scheme while one is known, `claude-code` from Claude Code's
// theme, else `claude`), its accent (and the focus ring, hover and text on it)
// taken from the `/color` session color when `accentFromSession` is on
// (default) and a color is set ('' is none).
export const resolveTheme = (
  settings: SettingsState | undefined,
  sessionColor: string,
  env: { scheme?: TermScheme; ccTheme?: string } = {},
): Theme => {
  const source = settings?.theme ?? DEFAULTS.theme
  const theme =
    source === 'terminal' && env.scheme !== undefined
      ? themeFromScheme(env.scheme)
      : source === 'claude-code'
        ? themeFromClaudeCode(env.ccTheme, env.scheme)
        : THEMES.claude
  const follow = settings?.accentFromSession ?? DEFAULTS.accentFromSession
  if (!follow || sessionColor === '') return theme
  const accent = sessionHex(sessionColor)

  return { ...theme, accent, focus: accent, accentHover: lighten(accent, 0.2), accentText: contrast(accent) }
}

export type KeyConfig = { editorKeymap?: unknown; editorKeys?: unknown }

// The editor keymap: preset (settings `keymap`, else userConfig
// `editorKeymap`, else jetbrains) <- userConfig `editorKeys` <- settings
// `keys`. Bad entries of either are skipped and named in `errors`.
export const mergeKeys = (
  userConfig: KeyConfig | undefined,
  settings: SettingsState | undefined,
): { keymap: Keymap; errors: string[] } => {
  const name = settings?.keymap ?? (userConfig?.editorKeymap === 'vscode' ? 'vscode' : 'jetbrains')
  const userKeys = typeof userConfig?.editorKeys === 'string' ? userConfig.editorKeys : undefined
  const fromUser = mergeKeymap(KEYMAPS[name], userKeys)
  const fromSettings = mergeKeymap(fromUser.keymap, settings?.keys)

  return {
    keymap: fromSettings.keymap,
    errors: [...fromUser.errors, ...fromSettings.errors.map(m => m.replace(/^editorKeys:/, 'settings keys:'))],
  }
}

// The page sizes the sheet offers for `gitLimit`.
export const GIT_LIMITS = [50, 100, 200, 500] as const

// What is wrong with a key overrides text, or undefined when it is good
// (empty is good: no overrides).
export const keysError = (text: string): string | undefined =>
  mergeKeymap(KEYMAPS.jetbrains, text).errors[0]?.replace(/^editorKeys: /, '')

// The git state with the Settings defaults where it has none: the tab and
// the commits shown (`limit`, absent until paged).
export const withGitDefaults = (s: GitState, settings: SettingsState | undefined): GitState & { limit: number } => ({
  ...s,
  tab: s.tab ?? settings?.gitTab,
  limit: s.limit ?? settings?.gitLimit ?? DEFAULTS.gitLimit,
})
