# claude-ide

An Explorer and a Git panel inside Claude Code, driven by the mouse (plugin `ide-panes`).

## Install

```sh
claude plugin marketplace add io-magestix/claude-ide-mx   # or a local clone's path
claude plugin install ide-panes@ide-panes                  # user scope by default
```

The plugin uses function hooks, early access in Claude Code: run it with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set (e.g. exported in your shell profile). To run it from a clone without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir <path>`.

The panels open with each new session and close on exit (Settings → Session). `/ide-panels` opens them by hand.

## Layout

One pane: Explorer on top (70%), Git below (30%), asking for 20% of the window's width. Drag the seam between them to resize. Outside a git repo Git shrinks to a two-row note; once a repo appears (`git init`, a clone) it comes back at 30%.

## Panels

- **Explorer**: file tree (Files, or Unity with `.meta` GUID references) with git change marks (`+` added, `*` edited), preview of code, Markdown, images and SVG, an in-pane editor, new file, delete, copy path, multi-select (ctrl/shift-click).
- **Git**: branches, commits with a lane graph and per-commit info, the working tree's changes as a tree with diffs, a diff view per commit, `Fetch` and `Pull` (`--ff-only`).

## Settings (⚙ in the Explorer's title row)

The panels always follow Claude Code's `/theme` (painted on Tabby's color scheme when running in Tabby).

- **Accent from /color**: your session color tints the accent and frames.
- **Session**: open on start, close on exit.
- Editor keymap (JetBrains or VS Code) and key overrides, panel defaults, reset layout.

Plugin options (`/config`): `editorKeymap`, `editorKeys`, `previewEngines` (external commands that preview more file types; see `.claude-plugin/plugin.json`).

## Develop

```sh
claude plugin validate .claude-plugin/plugin.json   # the plugin: hooks and $.state keys
claude plugin validate .                              # the marketplace
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .
npx -p typescript tsc -p .    # after a first load has generated .claude-plugin/types/
```

`docker/run.sh` runs Claude Code in a sandbox container with this repo mounted. See `CLAUDE.md` for the architecture.
