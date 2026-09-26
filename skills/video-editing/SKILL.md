# Video editing

Use DumbEditor's validated FFmpeg tools for project mutations. Inspect frames when the request depends on visible content, then apply the smallest sequence of edits that completes the request.

## Available operations

- Remove or keep time ranges.
- Change speed or mute a range.
- Crop the full frame.
- Use `transcribe_and_add_subtitles` when speech must become subtitles automatically. Burn supplied SRT, VTT, ASS, and SSA files directly.
- Overlay a generated image for a bounded time range with position, size, and opacity.
- Apply grayscale, sepia, blur, sharpen, or vignette to a range.
- Fade video and audio in or out.
- When prepared tools do not express the requested composition, use `render_custom_ffmpeg`. Input 0 is the active version and later inputs follow the ordered asset IDs. Produce labeled video and audio maps, then inspect the result before claiming success.

Each operation renders from the active immutable version, probes the output, and commits a new version. Never claim an edit succeeded unless its tool returned a version ID.
