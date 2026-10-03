import { Input, matchesKey } from "@earendil-works/pi-tui";
import { EXPORT_FORMATS, EXPORT_PRESET_DETAILS, EXPORT_PRESETS, exportDestination, type ExportFormat, type ExportPreset } from "../../core/export.js";
import { bold, accent, dim, gray, inverse } from "../views/style.js";
import { box, centered, Panel, setValueAtEnd, type PanelContext } from "./frame.js";

export type ExportFocus = "path" | "format" | "compression";
const FOCUS_ORDER: readonly ExportFocus[] = ["path", "format", "compression"];

export interface ExportPanelOptions {
  sourcePath: string;
  destination: string;
  format: ExportFormat;
  /** True while an export runs; the panel then ignores keys. */
  busy(): boolean;
  perform(choice: { destination: string; format: ExportFormat; preset: ExportPreset }): void;
  close(): void;
}

/** Choose where to save, MP4 or MKV, and how much to compress. */
export class ExportPanel extends Panel {
  format: ExportFormat;
  preset: ExportPreset = "balanced";
  focus: ExportFocus = "path";
  private readonly path = new Input({ prompt: "" });

  constructor(context: PanelContext, private readonly options: ExportPanelOptions) {
    super(context);
    this.format = options.format;
    setValueAtEnd(this.path, options.destination);
  }

  get destination(): string { return this.path.getValue(); }

  render(width: number): string[] {
    this.path.focused = this.focused && this.focus === "path";
    const modalWidth = Math.max(36, Math.min(96, width - 4));
    const preset = EXPORT_PRESET_DETAILS.find((item) => item.id === this.preset) ?? EXPORT_PRESET_DETAILS[2]!;
    const lines = [
      bold(accent("Export video")),
      dim("Destination"),
      ...box(this.path.render(Math.max(8, modalWidth - 10)), modalWidth - 6, { border: "round", color: this.focus === "path" ? accent : gray }),
      "",
      dim("Format"),
      (this.focus === "format" ? accent : (text: string) => text)(`${this.format === "mp4" ? "› " : "  "}[ MP4 ]    ${this.format === "mkv" ? "› " : "  "}[ MKV ]`),
      "",
      dim("Compression"),
      ...EXPORT_PRESET_DETAILS.map((item) => {
        const text = `${item.id === this.preset ? "›" : " "} ${item.label.padEnd(18)} ${item.video} · ${item.audio}`;
        return item.id === this.preset && this.focus === "compression" ? inverse(accent(text)) : item.id === this.preset ? text : dim(text);
      }),
      "",
      preset.description,
      dim("MP4 is broadly compatible. MKV is flexible for local playback and archiving."),
      dim("Tab section · arrows edit/select · type destination · Enter export · Esc close"),
    ];
    // On a short terminal the band is only about 11 rows: show the destination, one line for format and compression, and the keys.
    const compact = [
      bold(accent("Export video")),
      ...box(this.path.render(Math.max(8, modalWidth - 10)), modalWidth - 6, { border: "round", color: this.focus === "path" ? accent : gray }),
      (this.focus === "format" ? accent : (text: string) => text)(`Format ${this.format === "mp4" ? "[ MP4 ]  MKV " : "  MP4  [ MKV ]"}`)
        + "   " + (this.focus === "compression" ? inverse(accent(` ${preset.label} `)) : ` ${preset.label} `) + dim(`${preset.video} · ${preset.audio}`),
      dim(preset.description),
      dim("Tab section · arrows select · type destination · Enter export · Esc close"),
    ];
    const shown = lines.length + 2 <= this.rows ? lines : compact;
    return centered(box(shown, modalWidth, { border: "round", color: accent, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) { if (!this.options.busy()) this.options.close(); return; }
    if (this.options.busy()) return;
    if (matchesKey(data, "enter")) { this.options.perform({ destination: this.destination, format: this.format, preset: this.preset }); return; }
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.focus = cycle(FOCUS_ORDER, this.focus, matchesKey(data, "shift+tab") ? -1 : 1);
    } else if (this.focus === "format" || this.focus === "compression") {
      const direction = matchesKey(data, "left") || matchesKey(data, "up") ? -1 : matchesKey(data, "right") || matchesKey(data, "down") ? 1 : 0;
      if (direction !== 0 && this.focus === "format") {
        this.format = cycle(EXPORT_FORMATS, this.format, direction);
        setValueAtEnd(this.path, exportDestination(this.options.sourcePath, this.destination, this.format));
      } else if (direction !== 0) {
        this.preset = cycle(EXPORT_PRESETS, this.preset, direction);
      }
    } else {
      this.path.handleInput(data);
    }
    this.context.requestRender();
  }
}

function cycle<T extends string>(choices: readonly T[], current: T, direction: number): T {
  const index = Math.max(0, choices.indexOf(current));
  return choices[(index + direction + choices.length) % choices.length] ?? current;
}
