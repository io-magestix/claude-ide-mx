# claude-ide

An Explorer and a Git panel inside Claude Code, driven by the mouse (plugin `ide-panes`). Fork of [eLeSTRaGo-Dev/claude-ide](https://github.com/eLeSTRaGo-Dev/claude-ide).

## Install

```sh
claude plugin marketplace add io-magestix/claude-ide-mx   # or a local clone's path
claude plugin install ide-panes@ide-panes
```

The plugin uses function hooks, an early-access feature: set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (e.g. in your shell profile). To run from a clone without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir <path>`.

The panels open with each new session and close on exit; `/ide-panels` opens them by hand.

## Panels

One pane, 20% of the window wide: the Explorer on top, Git below, with a draggable seam between them. Outside a git repo, Git shrinks to a two-row note until a repo appears.

- **Explorer**: file tree (Files, or Unity with `.meta` GUID references) with file icons and git change marks; preview of code, Markdown, images and SVG; an in-pane editor for existing files; copy a file's name or full path.
- **Git**: branches, commits with a lane graph and commit info, working-tree changes with diffs, a diff view per commit, `Fetch` and `Pull` (`--ff-only`).

## Settings

Open them with ⚙ in the title row. The panels follow Claude Code's theme (on Tabby, its color scheme).

- Accent from `/color`, open on start and close on exit.
- File icons: Nerd Font, Basic or Off. Nerd Font is chosen by default when Tabby's font is a Nerd Font.
- Editor keymap (JetBrains or VS Code) with key overrides, panel defaults, reset layout.

Plugin options (`/config`): `editorKeymap`, `editorKeys`, `previewEngines` (external commands that preview more file types; see `.claude-plugin/plugin.json`).

## Develop

```sh
claude plugin validate .claude-plugin/plugin.json
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
npx -p typescript tsc -p .    # after a first load has generated .claude-plugin/types/
```

`docker/run.sh` runs Claude Code in a sandbox container with this repo mounted. See `CLAUDE.md` for the architecture.
