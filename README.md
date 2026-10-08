# claude-ide

An Explorer and a Git panel inside Claude Code, driven by the mouse (plugin `ide-panes`).

## Run

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir <path-to-this-repo>
```

Function hooks are early access in Claude Code; the variable turns them on.

The panels open with each new session and close on exit (Settings → Session). `/ide-panels` opens them by hand.

## Layout

- **Split** (default): one pane, Explorer on top (70%), Git below (30%), asking for 20% of the window's width. Drag the seam between them to resize. Outside a git repo Git shrinks to a three-row note; once a repo appears (`git init`, a clone) it comes back at 30%.
- **Tabs**: Explorer and Git as two tabbed panes.

Either way the panels open and close together.

## Panels

- **Explorer**: file tree (Files, or Unity with `.meta` GUID references), preview of code, Markdown, images and SVG, an in-pane editor, new file, delete, copy path, multi-select (ctrl/shift-click).
- **Git**: branches, commits with a lane graph and per-commit info, the working tree's changes with diffs, a diff view per commit, `fetch` and `pull --ff-only`. The current branch shows in the status line.

## Settings (⚙ in either panel)

- **Theme**: `Default`, `Match Terminal` (Tabby for now; greyed out in other terminals) or `Match Claude Code` (follows `/theme`).
- **Accent from /color**: your session color tints the accent and frames.
- **Panels**: split or tabs. **Session**: open on start, close on exit.
- Editor keymap (JetBrains or VS Code) and key overrides, panel defaults, reset layout.

Plugin options (`/config`): `editorKeymap`, `editorKeys`, `previewEngines` (external commands that preview more file types; see `.claude-plugin/plugin.json`).

## Develop

```sh
claude plugin validate .
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
npx -p typescript tsc -p .    # after a first load has generated .claude-plugin/types/
```

`docker/run.sh` runs Claude Code in a sandbox container with this repo mounted. See `CLAUDE.md` for the architecture.
