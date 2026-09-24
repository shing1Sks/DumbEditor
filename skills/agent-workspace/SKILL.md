# Agent workspace

The project workspace stores generated assets, subtitle files, notes, and reusable scripts. Paths are confined to the current project's `agent/workspace` directory and text files are limited to 1 MB.

Use `write_workspace_file` to create SRT or ASS subtitles and other supporting text. Read or list files before reusing them. The workspace persists across agent turns.

Arbitrary scripts may run only through a configured isolated container with no provider keys and no host filesystem access. When a container runtime is unavailable, script execution fails closed. The built-in FFmpeg editing tools remain available.

