import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ProviderModel } from "../src/core/models.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { MUSIC_CATALOG } from "../src/core/music-catalog.js";
import { ExportPanel } from "../src/shell/overlays/export.js";
import { HelpPanel } from "../src/shell/overlays/help.js";
import { ModelPanel, type ModelPanelServices } from "../src/shell/overlays/model.js";
import { MusicPanel, type MusicPanelServices } from "../src/shell/overlays/music.js";
import { plain } from "../src/shell/views/style.js";

const ROWS = 30;
const WIDTH = 110;
const context = { bandRows: () => ROWS, requestRender: () => undefined };
const KEY = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", esc: "\x1b", tab: "\t", shiftTab: "\x1b[Z", backspace: "\x7f", ctrlK: "\x0b", ctrlU: "\x15" };
const screen = (lines: string[]) => lines.map(plain).join("\n");
const later = () => new Promise((resolve) => setTimeout(resolve, 10));
const type = (panel: { handleInput(data: string): void }, text: string) => { for (const character of text) panel.handleInput(character); };
const assertFills = (lines: string[]) => {
  assert.equal(lines.length, ROWS);
  assert.ok(lines.every((line) => visibleWidth(line) === WIDTH));
};

function modelServices(overrides: Partial<ModelPanelServices> = {}) {
  const log = { loaders: [] as Array<string | null>, saved: [] as unknown[], closed: 0, listed: [] as string[] };
  const services: ModelPanelServices = {
    settings: () => structuredClone(DEFAULT_SETTINGS),
    keys: () => ({ openai: false, openrouter: true }),
    listModels: async (provider, slot) => {
      log.listed.push(`${provider}/${slot}`);
      return [{ id: "openai/gpt-6-luna", name: "GPT-6 Luna", inputPrice: "$0.10", outputPrice: "$0.50" }, { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", inputPrice: "$0.15", outputPrice: "$0.50" }] as ProviderModel[];
    },
    save: async (choice) => { log.saved.push(choice); },
    setLoader: (loader) => { log.loaders.push(loader ? loader.stage : null); },
    close: () => { log.closed += 1; },
    ...overrides,
  };
  return { services, log };
}

test("model picker: capability, then provider, then a searchable list, then save and close", async () => {
  const { services, log } = modelServices();
  const panel = new ModelPanel(context, services);
  assertFills(panel.render(WIDTH));
  assert.match(screen(panel.render(WIDTH)), /Select default model +Capability[\s\S]*> Base agent +OpenRouter \| [\s\S]*Transcription[\s\S]*Esc close/);
  panel.handleInput(KEY.enter);
  assert.match(screen(panel.render(WIDTH)), /Base agent \/ provider[\s\S]*> OpenRouter +configured \|/);
  panel.handleInput(KEY.enter);
  assert.equal(panel.picker.loading, true);
  assert.match(screen(panel.render(WIDTH)), /Loading provider catalog/);
  await later();
  assert.equal(panel.picker.loading, false);
  assert.deepEqual(log.loaders, ["Loading openrouter text models", null]);
  let text = screen(panel.render(WIDTH));
  assert.match(text, /Base agent \/ OpenRouter[\s\S]*Search >[\s\S]*MODEL +INPUT \/ 1M +OUTPUT \/ 1M[\s\S]*GPT-6 Luna \| openai\/gpt-6-luna[\s\S]*GLM 5\.3 Flash/);
  type(panel, "glm");
  text = screen(panel.render(WIDTH));
  assert.ok(!text.includes("GPT-6 Luna"), "the search narrows the list");
  assert.equal(panel.picker.selectedIndex, 0);
  panel.handleInput(KEY.enter);
  await later();
  assert.deepEqual(log.saved, [{ capability: "agent", provider: "openrouter", slot: "text", model: { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", inputPrice: "$0.15", outputPrice: "$0.50" } }]);
  assert.equal(log.closed, 1);
  assert.deepEqual(log.loaders.slice(-2), ["Saving model default", null]);
});

test("model picker: a failed catalog or save shows the reason, Enter retries, and Escape steps back and out", async () => {
  let attempts = 0;
  const { services, log } = modelServices({
    listModels: async () => { attempts += 1; if (attempts === 1) throw new Error("OpenRouter is unreachable"); return [{ id: "a/b", name: "AB" }]; },
    save: async () => { throw new Error("Could not write settings"); },
  });
  const panel = new ModelPanel(context, services);
  panel.handleInput(KEY.enter); panel.handleInput(KEY.enter);
  await later();
  assert.match(screen(panel.render(WIDTH)), /OpenRouter is unreachable[\s\S]*Press Enter to retry/);
  panel.handleInput(KEY.enter);
  await later();
  assert.match(screen(panel.render(WIDTH)), /AB \| a\/b/);
  panel.handleInput(KEY.enter);
  await later();
  assert.match(screen(panel.render(WIDTH)), /Could not write settings/);
  assert.equal(log.closed, 0, "stays open after a failed save");
  panel.handleInput(KEY.esc);
  assert.equal(panel.picker.step, "provider");
  panel.handleInput(KEY.esc);
  assert.equal(panel.picker.step, "capability");
  panel.handleInput(KEY.esc);
  assert.equal(log.closed, 1);
});

test("model picker ignores a slow answer after the user went back", async () => {
  let release: (models: ProviderModel[]) => void = () => undefined;
  const { services } = modelServices({ listModels: () => new Promise<ProviderModel[]>((resolve) => { release = resolve; }) });
  const panel = new ModelPanel(context, services);
  panel.handleInput(KEY.enter); panel.handleInput(KEY.enter);
  panel.handleInput(KEY.esc);
  release([{ id: "late/model", name: "Late" }]);
  await later();
  assert.equal(panel.picker.step, "provider");
  assert.deepEqual(panel.picker.models, []);
});

function musicServices(overrides: Partial<MusicPanelServices> = {}) {
  const log = { played: [] as string[], stopped: 0, selected: [] as string[], cleared: 0, status: [] as string[], closed: 0, ended: () => undefined as void };
  const services: MusicPanelServices = {
    play: (id, callbacks) => { log.played.push(id); log.ended = callbacks.onEnd; },
    stop: () => { log.stopped += 1; },
    select: async (track) => { log.selected.push(track.id); },
    clearSelection: async () => { log.cleared += 1; },
    setStatus: (text) => { log.status.push(text); },
    close: () => { log.closed += 1; },
    ...overrides,
  };
  return { services, log };
}

test("music: lists the catalog, searches by typing, previews with Space, and selects with Enter", async () => {
  const { services, log } = musicServices();
  const panel = new MusicPanel(context, services, null, "");
  assertFills(panel.render(WIDTH));
  const first = MUSIC_CATALOG[0]!;
  assert.match(screen(panel.render(WIDTH)), new RegExp(`Background music[\\s\\S]*Search ›[\\s\\S]*TITLE +MOOD[\\s\\S]*› +${first.title.slice(0, 10)}`));
  panel.handleInput(" ");
  assert.deepEqual(log.played, [first.id], "Space previews instead of typing a space");
  assert.match(screen(panel.render(WIDTH)), /› ▶ /);
  panel.handleInput(" ");
  assert.equal(log.stopped, 1, "Space again stops it");
  log.ended();
  type(panel, "zzzzzz");
  assert.match(screen(panel.render(WIDTH)), /No tracks match this search/);
  panel.handleInput(KEY.ctrlU);
  assert.equal(panel.tracks.length, MUSIC_CATALOG.length);
  panel.handleInput(KEY.down);
  panel.handleInput(KEY.enter);
  await later();
  assert.deepEqual(log.selected, [MUSIC_CATALOG[1]!.id]);
  assert.equal(log.closed, 1);
  assert.match(screen(panel.render(WIDTH)), /✓/, "the chosen track is ticked");
});

test("music: Ctrl+K clears the saved choice, a failed save is reported, Escape stops the preview and closes", async () => {
  const { services, log } = musicServices({ select: async () => { throw new Error("Could not save"); } });
  const panel = new MusicPanel(context, services, MUSIC_CATALOG[2]!.id, "");
  assert.match(screen(panel.render(WIDTH)), /✓/);
  panel.handleInput(KEY.ctrlK);
  await later();
  assert.equal(log.cleared, 1);
  assert.ok(log.status.includes("Background music selection cleared"));
  assert.ok(!screen(panel.render(WIDTH)).includes("✓"));
  panel.handleInput(KEY.enter);
  await later();
  assert.ok(log.status.includes("Could not save"));
  assert.equal(log.closed, 0);
  panel.handleInput(KEY.esc);
  assert.deepEqual([log.closed, log.stopped > 0], [1, true]);
  const searched = new MusicPanel(context, musicServices().services, null, "calm");
  assert.ok(searched.tracks.length > 0 && searched.tracks.length < MUSIC_CATALOG.length, "an opening query filters the list");
});

function exportPanel(overrides: { busy?: () => boolean } = {}) {
  const log = { performed: [] as unknown[], closed: 0 };
  const panel = new ExportPanel(context, {
    sourcePath: "C:/videos/demo.mp4", destination: "C:/videos/demo-export.mp4", format: "mp4",
    busy: overrides.busy ?? (() => false), perform: (choice) => { log.performed.push(choice); }, close: () => { log.closed += 1; },
  });
  return { panel, log };
}

test("export: edit the destination, change format and compression, and start the export", () => {
  const { panel, log } = exportPanel();
  assertFills(panel.render(WIDTH));
  let text = screen(panel.render(WIDTH));
  assert.match(text, /Export video[\s\S]*Destination[\s\S]*C:\/videos\/demo-export\.mp4[\s\S]*› \[ MP4 \] +\[ MKV \][\s\S]*› Balanced/);
  type(panel, "x");
  assert.equal(panel.destination, "C:/videos/demo-export.mp4x");
  panel.handleInput(KEY.backspace);
  panel.handleInput(KEY.tab);
  assert.equal(panel.focus, "format");
  panel.handleInput(KEY.right);
  assert.equal(panel.format, "mkv");
  assert.match(panel.destination.replace(/\\/g, "/"), /demo-export\.mkv$/, "the extension follows the format");
  panel.handleInput(KEY.tab);
  assert.equal(panel.focus, "compression");
  panel.handleInput(KEY.up);
  assert.equal(panel.preset, "high");
  text = screen(panel.render(WIDTH));
  assert.match(text, /› High quality/);
  panel.handleInput(KEY.shiftTab);
  assert.equal(panel.focus, "format");
  panel.handleInput(KEY.enter);
  assert.equal(log.performed.length, 1);
  assert.deepEqual({ ...(log.performed[0] as object), destination: String((log.performed[0] as { destination: string }).destination).replace(/\\/g, "/") }, {
    // The panel resolves the typed path; on Linux and macOS "C:/videos/..." is a relative path under the working directory.
    destination: resolve("C:/videos/demo-export.mkv").replace(/\\/g, "/"), format: "mkv", preset: "high",
  });
  panel.handleInput(KEY.esc);
  assert.equal(log.closed, 1);
});

test("export: while an export runs the panel ignores every key, including Escape", () => {
  const { panel, log } = exportPanel({ busy: () => true });
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.esc);
  type(panel, "abc");
  assert.deepEqual([log.performed.length, log.closed, panel.destination], [0, 0, "C:/videos/demo-export.mp4"]);
});

const PASTE = (text: string) => `\x1b[200~${text}\x1b[201~`;

test("model picker: a second Enter while the choice is being saved does not save it again", async () => {
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const { services, log } = modelServices({ save: async (choice) => { log.saved.push(choice); await pending; } });
  const panel = new ModelPanel(context, services);
  panel.handleInput(KEY.enter); panel.handleInput(KEY.enter);
  await later();
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.enter);
  panel.handleInput(KEY.enter);
  await later();
  assert.equal(log.saved.length, 1, "one save while the first is still running");
  release();
  await later();
  assert.equal(log.saved.length, 1);
  assert.equal(log.closed, 1);
});

test("model picker: pasted text reaches the search field", async () => {
  const { services } = modelServices();
  const panel = new ModelPanel(context, services);
  panel.handleInput(KEY.enter); panel.handleInput(KEY.enter);
  await later();
  panel.handleInput(PASTE("glm"));
  assert.equal(panel.picker.query, "glm");
  assert.ok(!screen(panel.render(WIDTH)).includes("GPT-6 Luna"), "the paste narrowed the list");
});

test("music: pasted text reaches the search field", () => {
  const { services } = musicServices();
  const panel = new MusicPanel(context, services, null, "");
  const target = MUSIC_CATALOG[2]!;
  panel.handleInput(PASTE(target.title));
  assert.ok(panel.tracks.length >= 1 && panel.tracks.length < MUSIC_CATALOG.length, "the paste narrowed the list");
  assert.ok(panel.tracks.some((track) => track.id === target.id));
});

test("Help and Export still fit in the 11 rows an 80x24 terminal gives a panel, with the box closed and the way out shown", () => {
  const short = { bandRows: () => 11, requestRender: () => undefined };
  const help = new HelpPanel(short, { model: () => "glm", close: () => undefined }).render(80).map(plain);
  assert.equal(help.length, 11);
  const helpText = help.join("\n");
  for (const wanted of ["Ctrl+P", "/export", "/model", "/bg-music", "/speed", "Esc closes this panel", "╰"]) assert.ok(helpText.includes(wanted), `help shows ${wanted}`);
  const full = new HelpPanel({ bandRows: () => 30, requestRender: () => undefined }, { model: () => "glm", close: () => undefined }).render(80).map(plain).join("\n");
  assert.ok(full.includes("Ask glm normally"), "the full version is unchanged on a tall terminal");

  const exportPanel = new ExportPanel(short, { sourcePath: "C:/videos/demo.mp4", destination: "C:/videos/demo-export.mp4", format: "mp4", busy: () => false, perform: () => undefined, close: () => undefined });
  const exported = exportPanel.render(80).map(plain);
  assert.equal(exported.length, 11);
  const exportText = exported.join("\n");
  for (const wanted of ["Export video", "demo-export.mp4", "Format", "Balanced", "Enter export", "╰"]) assert.ok(exportText.includes(wanted), `export shows ${wanted}`);
  const tall = new ExportPanel({ bandRows: () => 30, requestRender: () => undefined }, { sourcePath: "C:/videos/demo.mp4", destination: "C:/videos/demo-export.mp4", format: "mp4", busy: () => false, perform: () => undefined, close: () => undefined });
  assert.ok(tall.render(80).map(plain).join("\n").includes("MP4 is broadly compatible"), "the full version is unchanged on a tall terminal");
});
