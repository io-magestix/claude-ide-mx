export type ThemeName = 'claude'

// The Settings sheet's values; an absent field is its default
// (`hooks/shared/settings.ts` DEFAULTS). Saved whole to `$.store` `settings` (global).
export type SettingsState = {
  theme?: 'claude' | 'terminal' | 'claude-code' // `claude`: the plugin's palette; `terminal`: the terminal's color scheme (Tabby); `claude-code`: Claude Code's /config theme. Absent is `claude`
  accentFromSession?: boolean // the `/color` session color overrides the theme accent; absent is true
  keymap?: 'jetbrains' | 'vscode' // editor preset; absent falls back to userConfig `editorKeymap`
  keys?: string // JSON of action to chord or chords, merged over userConfig `editorKeys`
  explorerMode?: 'files' | 'unity' // Explorer's mode for a root with none saved
  gitTab?: 'overview' | 'graph' | 'changelog' // Git's panel tab while it has none chosen
  gitLimit?: number // commits per page
  autoOpen?: boolean // a new session opens the panels, an exit closes them; absent is true
}

// The Settings sheet while it is up; session only, never saved.
export type SettingsUi = {
  open?: 'ide-explorer' | 'ide-git' | 'ide-split' // the pane drawing the sheet; absent: closed
  before?: SettingsState // the values when it opened: Cancel puts them back
  keys?: string // the key overrides field as typed; absent: the saved `keys`
  keysError?: string // what is wrong with `keys`; the settings keep the last good text
}

export type ExplorerState = {
  root: string
  mode: 'files' | 'unity'
  expanded: string[]
  selected?: string // the file shown in the preview (Enter or click)
  cursor?: string // the row the arrows are on (the focus ring)
  offset: number
  previewOffset: number // first preview line shown
  previewLeft?: number // first preview column shown (horizontal bar); reset with previewOffset
  previewRaw?: boolean // the selected file shown as source instead of rendered (`v`: svg, markdown); reset with previewOffset
  deleting?: string // the file or dir the delete bar asks about; cleared by its `delete` or `cancel`
  deletingMany?: string[] // the marked paths the delete bar asks about (2+ marked when it opened); cleared with `deleting`
  marked?: string[] // the multi-selection (ctrl/shift-click, the mark cell, `m`); absent or empty: only `selected`
  edit?: {
    path: string // the file open in the Edit section
    baseMtime?: number // its mtime when loaded or last saved; absent for a new file
    isNew?: boolean // the file does not exist yet: created on first save
    hasDraft?: boolean // a draft file holds unsaved text for this path
    version: number // bumped to reload the buffer; chunks and drafts of an older one are dropped
    conflict?: 'disk' | 'changed' // `disk`: a save found the file changed; `changed`: Claude changed it under a dirty buffer
    confirm?: 'select' | 'close' | 'mode' | 'pane' | 'new' // the unsaved-changes bar and what it was asked for
    pending?: string // the path to select (`new`: the dir to name a file in) once the unsaved-changes bar is answered
  }
  split?: { tree?: number; panels?: number } // dragged sizes as fractions: Files' width (absent 0.35); the split pane's Explorer height (absent 0.7)
}

export type GitState = {
  ref: string // 'all' or a branch name
  selected?: string // commit sha
  offset: number
  limit?: number // commits shown; absent is the Settings page size (`gitLimit`, 200)
  branchOffset: number // first branch row shown
  detailOffset: number // first diff line shown (Diff Preview)
  infoOffset?: number // first Info line shown
  infoLeft?: number // first Info column shown (its horizontal bar); 0 when the shown commit changes
  detailLeft?: number // first Diff Preview column shown (its horizontal bar); 0 when the shown file or commit changes
  collapsed?: string[] // branch folders closed (`l:fix`, `r:origin/team`)
  tab?: 'overview' | 'graph' | 'changelog' // the panel view; absent is the Settings `gitTab` (`overview`). An old `'changes'` reads as `'changelog'`, any other unknown value as `overview`
  change?: string // path of the selected change
  changeOffset?: number // first change row shown
  changeCollapsed?: string[] // change folders closed (`c:src/ui`)
  diff?: string // sha open in the commit diff view; clearing it closes the view
  diffFile?: string // path of the selected file in the diff view
  split?: { side?: number; info?: number; files?: number; graph?: number } // dragged sizes as fractions: Branches' width, Info's height share (Overview), Files' width, Info's height share (Graph); absent is the default
  diffFileOffset?: number // first file row shown in the diff view
}

declare module 'claude-code' {
  interface PluginState {
    'ide-panes': {
      explorer: ExplorerState
      git: GitState
      sessionColor: string // `/color` name; '' is the default
      settings: SettingsState
      settingsUi: SettingsUi
    }
  }
}
