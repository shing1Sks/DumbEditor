// Ink 5 parses both byte 0x7f (Backspace on macOS and Linux) and ESC[3~ (forward
// Delete) as `delete`, and only byte 0x08 (Backspace on Windows) as `backspace`.
// The two `delete` sources cannot be told apart, so every text field treats
// `delete` as Backspace and has no forward-delete.
export function isBackspace(key: { backspace: boolean; delete: boolean }): boolean {
  return key.backspace || key.delete;
}

// Focus reporting (CSI ? 1004 h) makes the terminal send ESC[I and ESC[O. Ink
// strips the leading ESC before handing input to useInput, so match both forms.
export function isFocusReport(input: string): boolean {
  return input === "[I" || input === "[O" || input === "\u001B[I" || input === "\u001B[O";
}

// Where audio and video playback begin: replaying from the end restarts at zero.
export function playbackStart(time: number, duration: number): number {
  return time >= duration - 0.05 ? 0 : time;
}
