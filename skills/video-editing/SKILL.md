# Video editing

Use DumbEditor's validated FFmpeg tools for project mutations. Inspect frames when the request depends on visible content, then apply the smallest sequence of edits that completes the request.

## Available operations

- Remove or keep time ranges.
- Change speed or mute a range.
- Crop the full frame.
- Add text or burn SRT, VTT, ASS, and SSA subtitles.
- Overlay a generated image for a bounded time range with position, size, and opacity.
- Apply grayscale, sepia, blur, sharpen, or vignette to a range.
- Fade video and audio in or out.

Each operation renders from the active immutable version, probes the output, and commits a new version. Never claim an edit succeeded unless its tool returned a version ID.

