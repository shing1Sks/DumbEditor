// THROWAWAY SPIKE: can a Sixel video layer live inside pi-tui's fixed-size alternate screen without layout problems?
import {
  Box, Editor, HStack, ScrollView, Text, TuiAltScreen, VStack, Container, truncateToWidth, visibleWidth,
} from "@earendil-works/pi-tui";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
export const LEFT_W = 22;
export const RIGHT_W = 26;

const pad = (text, width) => {
  const cut = truncateToWidth(text, width);
  return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
};

class Panel {
  constructor(title, rows) { this.title = title; this.rows = rows; }
  render(width) {
    const lines = [pad(` ${this.title}`, width)];
    for (let i = 0; i < this.rows; i += 1) lines.push(pad(` ${this.title.toLowerCase()} item ${i + 1}`, width));
    return lines;
  }
  invalidate() {}
}

/** Reserves the video rectangle: blank cells the Sixel layer is painted over. */
class VideoRect {
  constructor(getRows) { this.getRows = getRows; }
  render(width) { return Array.from({ length: this.getRows() }, () => " ".repeat(width)); }
  invalidate() {}
}

/**
 * Terminal wrapper: holds each frame for one microtask (so pi-tui has updated its screen copy), then writes
 * frame + video layer as ONE synchronized update. The layer is only re-sent when something could have erased it.
 */
export class LayeredTerminal {
  constructor(inner, hooks) {
    this.inner = inner; this.hooks = hooks; this.pending = []; this.scheduled = false;
    this.lastBandKey = null; this.forced = true;
    this.stats = { frames: 0, layers: 0, frameBytes: 0, layerBytes: 0 };
  }
  get columns() { return this.inner.columns; }
  get rows() { return this.inner.rows; }
  get kittyProtocolActive() { return this.inner.kittyProtocolActive; }
  start(onInput, onResize) { this.inner.start(onInput, () => { this.forced = true; this.hooks.onResize?.(); onResize(); }); }
  stop() { this.inner.stop(); }
  drainInput(a, b) { return this.inner.drainInput(a, b); }
  moveBy(n) { this.inner.moveBy(n); } hideCursor() { this.inner.hideCursor(); } showCursor() { this.inner.showCursor(); }
  clearLine() { this.inner.clearLine(); } clearFromCursor() { this.inner.clearFromCursor(); } clearScreen() { this.forced = true; this.inner.clearScreen(); }
  setTitle(t) { this.inner.setTitle(t); } setProgress(a) { this.inner.setProgress(a); }
  force() { this.forced = true; }
  write(data) {
    this.pending.push(data);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }
  flush() {
    this.scheduled = false;
    let data = this.pending.join("");
    this.pending = [];
    const layer = this.hooks.layer();           // { key, output } | null
    let output = data;
    if (layer) {
      const bandKey = `${layer.rect.x},${layer.rect.y},${layer.rect.w},${layer.rect.h}|${this.hooks.bandText(layer.rect)}`;
      if (this.forced || bandKey !== this.lastBandKey || layer.videoRevision !== this.lastVideoRevision) {
        this.lastBandKey = bandKey; this.lastVideoRevision = layer.videoRevision; this.forced = false;
        this.stats.layers += 1; this.stats.layerBytes += layer.output.length;
        output = data.endsWith(SYNC_END) ? `${data.slice(0, -SYNC_END.length)}${layer.output}${SYNC_END}` : `${SYNC_START}${data}${layer.output}${SYNC_END}`;
      }
    } else if (this.lastBandKey !== null) { this.lastBandKey = null; this.forced = true; }
    this.stats.frames += 1; this.stats.frameBytes += data.length;
    this.inner.write(output);
  }
}

export function createApp({ terminal, sixel }) {
  const state = { videoRevision: 0, overlay: null, sixelRows: 0 };
  const layered = new LayeredTerminal(terminal, {
    onResize: () => rebuild(),
    layer: () => layerFor(),
    bandText: (rect) => tui.getScreenLines().slice(rect.y, rect.y + rect.h).join("\n"),
  });
  const tui = new TuiAltScreen(layered, true);

  const videoRows = () => Math.max(6, Math.min(layered.rows - 9, Math.floor(layered.rows * 0.5)));
  const rect = () => ({ x: LEFT_W, y: 0, w: Math.max(0, layered.columns - LEFT_W - RIGHT_W), h: videoRows() });

  const chat = new Container();
  const editor = new Editor(tui, { borderColor: (s) => s, selectList: {
    selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s, noMatch: (s) => s,
  } });
  const status = new Text("status: ready", 0, 0);
  const timeline = new Text("00:00 ----------------------------------------", 0, 0);
  const left = new Panel("ASSETS", 40);
  const right = new Panel("VERSIONS", 40);
  const video = new VideoRect(videoRows);
  const chatScroll = new ScrollView(chat, { follow: "end", primary: true });

  function buildRoot() {
    return new VStack([
      { component: new HStack([{ component: left, basis: LEFT_W, grow: 0, shrink: 0 }, { component: video, basis: 0, grow: 1, minSize: 1 }, { component: right, basis: RIGHT_W, grow: 0, shrink: 0 }]), basis: videoRows(), grow: 0, shrink: 0 },
      { component: timeline, basis: 1, grow: 0, shrink: 0 },
      { component: chatScroll, basis: 0, grow: 1, minSize: 1 },
      { component: editor, basis: "auto", shrink: 1, minSize: 1 },
      { component: status, basis: 1, grow: 0, shrink: 0 },
    ]);
  }
  function rebuild() { tui.setLayoutRoot(buildRoot()); }

  function overlapsOverlay(r) {
    const b = state.overlay?.isHidden?.() === false ? state.overlay.getBounds() : undefined;
    if (!b) return false;
    return b.col < r.x + r.w && b.col + b.width > r.x && b.row < r.y + r.h && b.row + b.height > r.y;
  }
  function layerFor() {
    const r = rect();
    const image = sixel(r, layered);
    if (!image || r.w < 4 || overlapsOverlay(r)) return null;
    return { rect: r, videoRevision: state.videoRevision, output: `\x1b7\x1b[${r.y + 1};${r.x + 1}H${image}\x1b8` };
  }

  rebuild();
  tui.setFocus(editor);
  return {
    tui, layered, editor, chat, status, rect, state,
    say(text) { chat.addChild(new Text(text, 1, 0)); tui.requestRender(); },
    newVideoFrame() { state.videoRevision += 1; tui.requestRender(); },
    showPopup() {
      const box = new Box(2, 1);
      box.addChild(new Text("Allow generate_asset?  [Enter] allow  [Esc] deny", 0, 0));
      state.overlay = tui.showOverlay(box, { anchor: "center", width: 56 });
      tui.requestRender();
    },
    hidePopup() { state.overlay?.hide(); state.overlay = null; layered.force(); tui.requestRender(); },
    start() { tui.start(); },
    stop() { tui.stop(); },
  };
}
