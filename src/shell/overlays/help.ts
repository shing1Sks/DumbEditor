import { matchesKey } from "@earendil-works/pi-tui";
import { bold, accent, dim } from "../views/style.js";
import { box, fill, Panel, type PanelContext } from "./frame.js";

export class HelpPanel extends Panel {
  constructor(context: PanelContext, private readonly options: { model: () => string; close: () => void }) { super(context); }

  render(width: number): string[] {
    const lines = [
      bold(accent("DumbEditor controls")),
      "Ctrl+P play/pause  ←/→ seek 5s  +/- volume  [ set in  ] set out",
      "/clip-remove FROM TO [FROM TO...]  /clip-keep FROM TO",
      "/speed FROM TO FACTOR  /mute FROM TO  /crop WIDTHxHEIGHT [X,Y]",
      "/open path  /projects  /version [all]  /revert id  /undo",
      "/export [path] popup  /version-limits [N]  /model model picker",
      "/bg-music music browser  /assets asset browser  (also Ctrl+O)",
      "/permissions [ask|auto]  /budget [USD]  /compact",
      dim("Editing: Ctrl+Backspace deletes a word, Ctrl+Delete the next one, Ctrl+U / Ctrl+K the row."),
      dim("Type / for commands, use ↑/↓ to choose, and Tab to complete."),
      dim("↑/↓ scroll chat, PgUp/PgDn move a page, Ctrl+G expands chat."),
      dim("While the agent works: Enter sends a message that steers it, Esc stops it."),
      dim(`Ask ${this.options.model()} normally: “remove the first two seconds and the last ten”.`),
      dim("Esc closes this panel"),
    ];
    // On a short terminal the band is only about 11 rows: use a version with the same facts in fewer lines.
    const compact = [
      bold(accent("DumbEditor controls")),
      "Ctrl+P play/pause  ←/→ seek 5s  +/- volume  [ set in  ] set out",
      "/clip-remove FROM TO  /clip-keep FROM TO  /speed FROM TO FACTOR  /mute FROM TO",
      "/crop WxH [X,Y]  /open path  /projects  /version [all]  /revert id  /undo",
      "/export [path]  /version-limits [N]  /model  /bg-music  /assets (Ctrl+O)",
      "/permissions [ask|auto]  /budget [USD]  /compact",
      dim("Ctrl+Backspace/Delete word, Ctrl+U/K row · / commands, ↑/↓ choose, Tab complete"),
      dim("Agent working: Enter steers, Esc stops · ↑/↓ PgUp/PgDn scroll, Ctrl+G chat"),
      dim("Esc closes this panel"),
    ];
    const room = this.rows - 2;
    const shown = lines.length <= room ? lines : compact.length <= room ? compact : [...compact.slice(0, Math.max(1, room - 1)), compact[compact.length - 1] as string];
    return fill(box(shown, width, { border: "round", color: accent }), width, this.rows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.options.close();
  }
}
