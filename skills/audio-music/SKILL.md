# Audio and music

Use `search_music_catalog` for free background tracks. Every bundled catalog record includes its source, license URL, and required attribution. `/bg-music` lets the user search, preview, stop, and persist a selection before asking Luna to mix it.

For mixing:

- Use source `selected` for the user's `/bg-music` choice.
- Use source `catalog` with a track ID after a catalog search.
- Use source `asset` with an asset ID for generated music or speech.
- Start at 25% volume unless the request specifies another level.
- Loop short music when it should span the video.
- Preserve the original audio and mix below it unless the user asks to replace it.

