// Focus reporting (CSI ? 1004 h) makes the terminal send ESC[I and ESC[O when the window gains or loses focus.
// They must never reach a text field, so they are recognised with or without the leading ESC.
export function isFocusReport(input: string): boolean {
  return input === "[I" || input === "[O" || input === "\u001B[I" || input === "\u001B[O";
}

// Where audio and video playback begin: replaying from the end restarts at zero.
export function playbackStart(time: number, duration: number): number {
  return time >= duration - 0.05 ? 0 : time;
}
