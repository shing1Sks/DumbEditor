import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";

/**
 * Extra keys for editing the message box, on top of pi-tui's own (Ctrl+W and Alt+Backspace delete a word, Ctrl+U and
 * Ctrl+K delete to the start and end of the row):
 * - Ctrl+Backspace deletes the word before the cursor and Ctrl+Delete the word after it. Windows Terminal reports
 *   Ctrl+Backspace as a plain backspace byte, which pi-tui already recognises there.
 * - Ctrl+Shift+Backspace and Ctrl+Shift+Delete delete the whole row before and after the cursor, in terminals that
 *   can tell those keys apart.
 */
const EXTRA_KEYS: ReadonlyArray<readonly [Keybinding, readonly KeyId[]]> = [
  ["tui.editor.deleteWordBackward", ["ctrl+backspace"]],
  ["tui.editor.deleteWordForward", ["ctrl+delete"]],
  ["tui.editor.deleteToLineStart", ["ctrl+shift+backspace"]],
  ["tui.editor.deleteToLineEnd", ["ctrl+shift+delete"]],
];

export function applyEditingKeys(): void {
  const keybindings = getKeybindings();
  const bindings = { ...keybindings.getUserBindings() };
  for (const [id, extra] of EXTRA_KEYS) bindings[id] = [...new Set([...keybindings.getKeys(id), ...extra])];
  keybindings.setUserBindings(bindings);
}
