// Re-exports the native canvas library. This package exists so that npm installs it only on macOS and Linux
// (the "os" field in package.json): Windows has an FFmpeg with libass and never needs it.
export * from "@napi-rs/canvas";
