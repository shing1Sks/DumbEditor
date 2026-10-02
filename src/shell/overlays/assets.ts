import { basename } from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import type { AgentAsset } from "../../core/agent-workspace.js";
import { extractFrame, streamPreview, type PreviewSize, type PreviewStream } from "../../core/media.js";
import { formatUsd } from "../../core/usage.js";
import { assetIcon, boxed } from "../views/sidebars.js";
import { bold, accent, dim, green, inverse, shorten, spaceBetween } from "../views/style.js";
import { box, fill, isPrintable, listWindow, Panel, wrapIndex, type PanelContext } from "./frame.js";

export interface AssetPanelOptions {
  assets: () => readonly AgentAsset[];
  /** True while the app is playing the selected asset's sound. */
  playing: () => boolean;
  togglePlay(asset: AgentAsset): void;
  stopPlay(): void;
  /** The user started typing: close the panel and put the text in the composer. */
  typeText(text: string): void;
  close(): void;
  /** Test seams; the real ones read the file with FFmpeg. */
  loadFrame?: (path: string, size: PreviewSize, signal: AbortSignal) => Promise<string>;
  streamFrames?: (path: string, size: PreviewSize, onFrame: (frame: string) => void, onEnd: () => void) => PreviewStream;
}

/** Browse the project's generated and imported assets, with a small preview of images and video. */
export class AssetPanel extends Panel {
  private selected: number;
  private preview = { key: "", lines: [] as string[], stop: () => undefined as void };

  constructor(context: PanelContext, private readonly options: AssetPanelOptions) {
    super(context);
    this.selected = Math.max(0, options.assets().length - 1);
  }

  render(width: number): string[] {
    const assets = this.options.assets();
    this.selected = Math.min(this.selected, Math.max(0, assets.length - 1));
    const selected = assets[this.selected];
    const inner = Math.max(20, width - 4);
    const listWidth = Math.max(26, Math.floor(width * 0.38));
    const detailWidth = Math.max(20, inner - listWidth - 2);
    const room = Math.max(1, this.rows - 5);
    const header = spaceBetween(bold(accent("Assets")), dim("↑/↓ select · Space play · Ctrl+O/Esc close · type to chat"), inner);
    if (assets.length === 0) {
      return fill(box([header, dim("No project assets yet. Ask the editor agent to create an image, sound, video, or subtitles.")], width, { border: "round", color: accent }), width, this.rows);
    }
    const { start, end } = listWindow(assets.length, this.selected, room - 2);
    const list = boxed(assets.slice(start, end).map((asset, offset) => {
      const index = start + offset;
      const cost = asset.costUsd === undefined ? "cost unavailable" : formatUsd(asset.costUsd, asset.costEstimated);
      const text = `${index === this.selected ? "›" : " "} ${assetIcon(asset.kind)} ${asset.description} · ${cost}`;
      return index === this.selected ? inverse(accent(text)) : text;
    }), listWidth, Math.min(room, end - start + 2));
    const details = selected ? this.details(selected, detailWidth, room) : [];
    const rows = Array.from({ length: room }, (_, index) => `${list[index] ?? " ".repeat(listWidth)}  ${details[index] ?? ""}`);
    return fill(box([header, ...rows], width, { border: "round", color: accent }), width, this.rows);
  }

  handleInput(data: string): void {
    const assets = this.options.assets();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o")) { this.stopPreview(); this.options.stopPlay(); this.options.close(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      this.options.stopPlay();
      this.selected = wrapIndex(this.selected, matchesKey(data, "up") ? -1 : 1, assets.length);
    } else if (data === " ") {
      const asset = assets[this.selected];
      if (asset && ["audio", "music", "video"].includes(asset.kind)) this.options.togglePlay(asset);
    } else if (isPrintable(data)) {
      this.stopPreview(); this.options.stopPlay(); this.options.close(); this.options.typeText(data);
      return;
    }
    this.context.requestRender();
  }

  /** Stop any preview work, for example when the panel is closed. */
  dispose(): void { this.stopPreview(); }

  private details(asset: AgentAsset, width: number, rows: number): string[] {
    const playable = asset.kind === "audio" || asset.kind === "music" || asset.kind === "video";
    const lines = [
      bold(`${assetIcon(asset.kind)} ${shorten(asset.description, width - 2)}`),
      dim(basename(asset.path)),
      `Type: ${asset.kind}`,
      `Source: ${asset.source}`,
      `Model: ${asset.model ?? "local"}`,
      `Cost: ${asset.costUsd === undefined ? "unavailable" : formatUsd(asset.costUsd, asset.costEstimated)}`,
      ...(asset.license ? [`License: ${shorten(asset.license, width - 9)}`] : []),
      ...(playable ? [this.options.playing() ? green("▶ playing preview") : accent("Space plays this asset")] : []),
      ...(asset.kind === "image" ? [accent("Image saved and ready for the editor agent to place in the video.")] : []),
      ...(asset.kind === "file" ? [accent("Subtitle or workspace file saved as a reusable asset.")] : []),
    ];
    if (asset.kind === "image" || asset.kind === "video") {
      const previewRows = Math.max(2, rows - lines.length - 1);
      lines.push(...this.previewLines(asset, width, previewRows));
    }
    return lines.slice(0, rows);
  }

  private previewLines(asset: AgentAsset, width: number, rows: number): string[] {
    const size: PreviewSize = { width: Math.max(2, Math.floor((width - 2) / 2) * 2), height: Math.max(2, rows * 2) };
    const playing = asset.kind === "video" && this.options.playing();
    const key = `${asset.path}|${size.width}x${size.height}|${playing}`;
    if (key !== this.preview.key) {
      this.stopPreview();
      this.preview = { key, lines: ["Loading preview…"], stop: () => undefined };
      const controller = new AbortController();
      const show = (text: string) => { if (this.preview.key === key) { this.preview.lines = text.split("\n"); this.context.requestRender(); } };
      if (playing) {
        const stream = (this.options.streamFrames ?? defaultStream)(asset.path, size, show, () => undefined);
        this.preview.stop = () => stream.stop();
      } else {
        this.preview.stop = () => controller.abort();
        void (this.options.loadFrame ?? ((path, wanted, signal) => extractFrame(path, 0, wanted, signal)))(asset.path, size, controller.signal).then(show).catch(() => show("Preview unavailable"));
      }
    }
    return this.preview.lines.slice(0, rows);
  }

  private stopPreview(): void {
    this.preview.stop();
    this.preview = { key: "", lines: [], stop: () => undefined };
  }
}

function defaultStream(path: string, size: PreviewSize, onFrame: (frame: string) => void, onEnd: () => void): PreviewStream {
  return streamPreview({ filePath: path, start: 0, size, fps: 6, onFrame, onEnd, onError: () => onFrame("Preview unavailable") });
}
