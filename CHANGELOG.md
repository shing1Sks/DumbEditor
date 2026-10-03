# Changelog

All notable changes to DumbEditor. Versions follow [semantic versioning](https://semver.org): while the major number is 0, a new minor number (0.2, 0.3) can change how things work, and a patch number (0.2.1) only fixes things. Newest first.

## 0.2.0 - 2026-10-03

A new screen, a new agent engine, and a picture that works outside Windows.

### Added
- **New full-screen interface** with a sidebar of versions and assets, a player with timeline, a scrollable chat and a multi-line message box. Only the rows that changed are redrawn, so typing, streaming answers and resizing do not disturb the video.
- **A streaming editor agent** you can watch, steer by typing while it works, and stop with Esc. Long sessions are compacted automatically (or with `/compact`) and resume after a restart. A per-run spend limit (`/budget`) pauses the agent and asks before it goes on. OpenRouter is the one model provider.
- **A real picture on Mac and Linux.** The editor asks the terminal what it can show: Kitty graphics (kitty, Ghostty, WezTerm, Konsole, iTerm2), then Sixel, then block art. 256-colour block art for Terminal.app. Windows keeps Sixel in Windows Terminal exactly as before.
- **`dumbeditor update`** installs the newest release (`--tag next` for previews). The editor looks for a newer version at most once a day and tells you after it closes. Off with `DUMBEDITOR_NO_UPDATE_CHECK=1`.
- **`dumbeditor doctor`** checks Node, FFmpeg (encoders, filters), how text is drawn, `ffplay`, the picture in use, the agent sandbox and the provider key, and prints the install command for your system.
- **Text and captions without libass.** Homebrew's plain `ffmpeg` has no libass; text and SRT/VTT captions are drawn as images instead (`dumbeditor-canvas` is installed on Mac and Linux for this).
- **`/mode`**: a list to pick how the agent gets permission (`ask` or `auto`). **Shift+Tab** flips it from anywhere.
- **Ctrl+Left / Ctrl+Right** seek five seconds even while text is in the message box.
- `DUMBEDITOR_FFMPEG_DIR` to name the FFmpeg folder; Homebrew's `ffmpeg-full` is used automatically on a Mac when installed. Also `DUMBEDITOR_PREVIEW`, `DUMBEDITOR_CELL_WIDTH/HEIGHT`, `DUMBEDITOR_COLOR`, `DUMBEDITOR_KITTY_COMPRESS`.

### Changed
- Install with `npm install -g dumbeditor`, then just run `dumbeditor`. The README and dumbcli.com say so.
- `/permissions` is now `/mode` (the old name still works).
- Needs Node.js 22.19 or newer.
- Help and Export panels fit an 80x24 terminal.

### Fixed
- Keys on macOS Terminal (input hotfix).
- A second Enter no longer saves the model twice; pasting works in the model and music search; a panel replaced by another stops what it started.
- The preview's FFmpeg no longer lingers after quit on Linux and macOS.
- Text on rotated clips is placed correctly; overlapping captions no longer stack.

### Removed
- The Ink-based interface.

## 0.1.0

First public release: terminal video editor with an Ink interface, slash commands and an editor agent.
