# Agent workspace

The project workspace stores generated assets, subtitle files, notes, and reusable scripts. Paths are confined to the current project's `agent/workspace` directory and text files are limited to 1 MB.

Use `write_workspace_file` to create SRT or ASS subtitles and other supporting text. Read or list files before reusing them. The workspace persists across agent turns.

Call `sandbox_status` before attempting a script. Python and JavaScript scripts run through DumbEditor's local OS sandbox with networking disabled, no provider keys, a read-only active video passed as the first argument, and the current project workspace as the sole writable location. Register any useful output with `register_workspace_asset`, then consume it with an editing or custom FFmpeg tool. If the native sandbox is unavailable, script execution fails closed while the custom and prepared FFmpeg tools remain available.
