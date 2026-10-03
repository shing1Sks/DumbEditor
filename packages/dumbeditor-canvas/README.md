# dumbeditor-canvas

A thin package for [DumbEditor](https://github.com/shing1Sks/DumbEditor). It depends on
[`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) and re-exports it.

DumbEditor draws text overlays and captions as images when the installed FFmpeg has no libass (Homebrew's plain
`ffmpeg`, for example). That needs a native library of about 36 MB. Windows FFmpeg builds include libass, so this
package declares `"os": ["darwin", "linux"]` and npm skips it on Windows.

You do not install this directly: `dumbeditor` lists it as an optional dependency.
