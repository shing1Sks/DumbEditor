import { HStack, Spacer, TuiAltScreen, VStack, type Component, type Terminal } from "@earendil-works/pi-tui";
import type { CommandDefinition } from "../core/commands.js";
import type { PreviewBackend } from "../core/media.js";
import { applyEditingKeys } from "./input/editing-keys.js";
import { resolveKey, type Intent, type KeyContext } from "./input/keymap.js";
import { shellLayout, type ShellLayout } from "./layout.js";
import { PreviewHost } from "./preview/preview-host.js";
import type { CellRect } from "./preview/video-layer.js";
import type { OverlayKind, ShellState } from "./state/shell-state.js";
import { StatusView, ControlsView } from "./views/controls.js";
import { Composer } from "./views/composer.js";
import { HeaderView } from "./views/header.js";
import { AssetsSidebarView, ProjectSidebarView } from "./views/sidebars.js";
import { TimelineView } from "./views/timeline.js";
import { TranscriptView } from "./views/transcript.js";
import { VideoView } from "./views/video-view.js";

export interface OverlayContext {
  /** Height of the band the panel fills. */
  bandRows: () => number;
  close(): void;
}

export interface ScreenHooks {
  /** A line the user sent: a slash command, or a request for the agent. */
  onSubmit(text: string): void;
  /** Ctrl+C: stop the agent if it is running, otherwise quit. */
  onInterrupt(): void;
  onAbortAgent(): void;
  onOpenAssets(): void;
}

export interface ScreenOptions {
  terminal: Terminal;
  state: ShellState;
  backend: PreviewBackend;
  commands: readonly CommandDefinition[];
  cwd: string;
  hooks: ScreenHooks;
  /** Builds the panel for an overlay kind. A panel replaces the video band while it is open and receives the keys. */
  overlays?: (kind: OverlayKind, context: OverlayContext) => Component | null;
  /** Called after the layout was rebuilt, for example after a resize, so playback can use the new picture size. */
  onLayout?: () => void;
}

/** pi-tui's screen with the editor's layout: header, a band (sidebars and video, or a panel), timeline, chat, composer, status. */
export function createShellScreen(options: ScreenOptions) {
  const { state, backend, hooks } = options;
  applyEditingKeys();
  let layout: ShellLayout = { bandRows: 0, leftSidebarColumns: 0, videoColumns: 0, rightSidebarColumns: 0, gap: 0 };
  let layoutKey = "";
  let activeOverlay: { kind: OverlayKind; component: Component } | null = null;

  const preview: PreviewHost = new PreviewHost(options.terminal, {
    visible: () => state.media !== null && state.overlay === null && !state.chatExpanded,
    rect: () => videoRect(),
    screenLines: () => tui.getScreenLines(),
    onResize: () => relayout(),
  });
  const tui = new TuiAltScreen(preview.terminal, true);
  const bandRows = () => layout.bandRows;

  const transcript = new TranscriptView();
  const composer = new Composer(tui, {
    commands: options.commands, cwd: options.cwd, onSubmit: (text) => hooks.onSubmit(text),
    // Everything else on screen: header and spacer, the band with the play rows (not when the chat is expanded),
    // the spacer above the box, the status row, and at least one row of chat.
    maxRows: () => options.terminal.rows - (state.chatExpanded ? 4 : layout.bandRows + 6) - 1,
  });
  const header = new HeaderView(state);
  const timeline = new TimelineView(state, () => ({ leftPad: layout.leftSidebarColumns + layout.gap, videoColumns: layout.videoColumns }));
  const controls = new ControlsView(state, () => backend);
  const status = new StatusView(state);
  const video = new VideoView(state, bandRows);
  const left = new ProjectSidebarView(state, bandRows);
  const right = new AssetsSidebarView(state, bandRows);

  function videoRect(): CellRect {
    // Below the header and the spacer row under it, after the left sidebar and its gap.
    return { x: layout.leftSidebarColumns + layout.gap, y: 2, w: layout.videoColumns, h: layout.bandRows };
  }

  function band(): Component {
    if (activeOverlay) return activeOverlay.component;
    const entries = [];
    if (layout.leftSidebarColumns > 0) entries.push({ component: left, basis: layout.leftSidebarColumns, grow: 0, shrink: 0 });
    entries.push({ component: video, basis: 0, grow: 1, minSize: 1 });
    if (layout.rightSidebarColumns > 0) entries.push({ component: right, basis: layout.rightSidebarColumns, grow: 0, shrink: 0 });
    return new HStack(entries, { gap: layout.gap });
  }

  function buildRoot(): Component {
    const fixed = (component: Component, rows: number) => ({ component, basis: rows, grow: 0, shrink: 0 });
    // The spacer above the prompt box gives way first when the terminal is short.
    const breathing = { component: new Spacer(1), basis: 1, grow: 0, shrink: 1, minSize: 0 };
    const chat = { component: transcript.view, basis: 0, grow: 1, minSize: 1 };
    const tail = [breathing, { component: composer.editor, basis: "auto" as const, shrink: 1, minSize: 1 }, fixed(status, 1)];
    if (state.chatExpanded) return new VStack([fixed(header, 1), fixed(new Spacer(1), 1), chat, ...tail]);
    return new VStack([
      fixed(header, 1),
      fixed(new Spacer(1), 1),
      fixed(band(), layout.bandRows),
      fixed(timeline, 1),
      fixed(controls, 1),
      chat,
      ...tail,
    ]);
  }

  /** Rebuild the layout when anything that shapes it changed. */
  function relayout(): void {
    layout = shellLayout({ columns: options.terminal.columns, rows: options.terminal.rows }, state.media, backend);
    const key = `${options.terminal.columns}x${options.terminal.rows}|${layout.bandRows}|${layout.leftSidebarColumns}|${layout.videoColumns}|${activeOverlay?.kind ?? ""}|${state.chatExpanded}`;
    if (key === layoutKey) return;
    layoutKey = key;
    tui.setLayoutRoot(buildRoot());
    options.onLayout?.();
  }

  function syncOverlay(): void {
    if (state.overlay === null) {
      if (activeOverlay) { activeOverlay = null; tui.setFocus(composer.editor); }
      return;
    }
    if (activeOverlay?.kind === state.overlay) return;
    const component = options.overlays?.(state.overlay, { bandRows, close: () => state.closeOverlay() }) ?? null;
    activeOverlay = component ? { kind: state.overlay, component } : null;
    tui.setFocus(component ?? composer.editor);
  }

  function sync(): void {
    transcript.sync(state.messages);
    composer.setStatus(
      state.agentRunning ? "working · Enter steers · Esc stops" : state.busy ? (state.loader?.stage ?? "working") : `${state.permissionMode} · ${state.agentModel}`,
      state.busy ? "blocked" : state.agentRunning ? "working" : "idle",
    );
    const restored = state.takeComposerRestore();
    if (restored) composer.restore(restored);
    syncOverlay();
    relayout();
    tui.requestRender();
  }

  function keyContext(): KeyContext {
    return {
      overlayOpen: state.overlay !== null, composerEmpty: composer.isEmpty(), agentRunning: state.agentRunning, busy: state.busy,
      videoMutationActive: state.videoMutationActive, chatExpanded: state.chatExpanded, hasMedia: state.media !== null,
    };
  }

  function apply(intent: Intent): void {
    switch (intent.type) {
      case "interrupt": hooks.onInterrupt(); break;
      case "abort-agent": hooks.onAbortAgent(); break;
      case "open-assets": hooks.onOpenAssets(); break;
      case "toggle-chat-focus": state.toggleChatExpanded(); break;
      case "collapse-chat": state.setChatExpanded(false); break;
      case "clear-composer": composer.clear(); tui.requestRender(); break;
      case "scroll-chat": transcript.scrollBy(intent.rows); tui.requestRender(); break;
      case "scroll-chat-page": transcript.scrollBy(intent.direction * transcript.pageRows()); tui.requestRender(); break;
      case "seek": state.setPlaying(false); state.movePlayhead(intent.seconds); break;
      case "toggle-play": state.togglePlaying(); break;
      case "volume": state.adjustVolume(intent.delta); break;
      case "mark-in": state.setIn(); break;
      case "mark-out": state.setOut(); break;
      case "ignore": break;
    }
  }

  tui.addInputListener((data) => {
    const intent = resolveKey(data, keyContext());
    if (!intent) return undefined;
    apply(intent);
    return { consume: true };
  });
  const unsubscribe = state.subscribe(sync);
  tui.setFocus(composer.editor);
  sync();

  return {
    tui, preview, composer, transcript,
    layout: () => layout,
    videoRect,
    /** Re-read the state and redraw, for example after changes made outside the state object. */
    refresh: sync,
    start(): void { tui.start(); },
    // Leave the screen alone on the way out: without this pi-tui prints a copy of the interface into the shell.
    stop(): void { unsubscribe(); tui.stop({ preserveScreen: true }); },
  };
}

export type ShellScreen = ReturnType<typeof createShellScreen>;
