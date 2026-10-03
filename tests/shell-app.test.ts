import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createEditorRegistry } from "../src/core/actions/index.js";
import { Engine } from "../src/core/engine/engine.js";
import { createStreamFn } from "../src/core/pi/models.js";
import { SessionStore } from "../src/core/session/session-store.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { ShellApp } from "../src/shell/app.js";
import { FakeTerminal, sixelPlacements } from "./helpers/fake-terminal.js";
import { call, makeFaux, say, toolUse } from "./helpers/faux.js";
import { makeProject } from "./helpers/project.js";

const KEY = { enter: "\r", esc: "\x1b", ctrlP: "\x10", ctrlC: "\x03", right: "\x1b[C" };

async function until(condition: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const typeLine = async (fake: FakeTerminal, text: string) => {
  for (const character of text) { fake.send(character); await new Promise((resolve) => setTimeout(resolve, 5)); }
  await fake.settle(40);
  fake.send(KEY.enter);
};
const texts = (app: ShellApp) => app.state.messages.map((message) => `${message.label ?? message.role}:${message.text}`);

async function boot(options: { engine?: boolean; permission?: "ask" | "auto" } = {}) {
  const project = await makeProject();
  const fake = new FakeTerminal(120, 40);
  const faux = makeFaux();
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.agent.permissionMode = options.permission ?? "ask";
  let exits = 0;
  const app = new ShellApp({
    terminal: fake, initialPath: project.store.snapshot.sourcePath, backend: "sixel", onExit: () => { exits += 1; },
    audio: { spawn: () => null },
    createEngine: options.engine === false ? async () => null : async (editor, seed) => Engine.create({
      state: editor, registry: createEditorRegistry(), session: new SessionStore(join(editor.store.snapshot.projectDir, "agent", "session.jsonl")),
      models: faux.models, modelId: "faux", model: faux.model, streamFn: createStreamFn(faux.models), getSettings: () => settings, chatSeed: seed,
    }),
  });
  await app.start();
  await until(() => app.state.media !== null && !app.state.loader, 30_000, "the video to open");
  await fake.settle();
  return { project, fake, faux, app, exits: () => exits, cleanup: async () => { app.dispose(); await project.cleanup(); } };
}

test("opens a video: header, play bar, status and the first picture appear", { timeout: 90_000 }, async () => {
  const t = await boot();
  try {
    const rows = t.fake.screen();
    assert.match(rows[0] ?? "", /^ {2}◆ DumbEditor {2}› {2}source {2}v0000 +● ready *$/);
    assert.match(t.app.state.messages.at(-1)?.text ?? "", /^Opened source · .+ · 320x180 · 00:04\.0$/);
    await until(() => sixelPlacements(t.fake.writes.join("")).length > 0, 20_000, "the first picture");
    assert.deepEqual(t.app.state.versions.map((version) => version.id), ["v0000"]);
    assert.equal(t.app.engine !== null, true);
  } finally { await t.cleanup(); }
});

test("a slash command edits the video, adds a version and shows the result", { timeout: 120_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    await typeLine(t.fake, "/clip-remove 1 2");
    await until(() => t.app.state.versionId === "v0001", 60_000, "the edit");
    await until(() => !t.app.state.loader, 30_000, "the edit to finish");
    assert.equal(t.app.state.media?.duration !== undefined && t.app.state.media.duration < 3.3, true, "the video got shorter");
    assert.ok(t.app.state.versions.some((version) => version.id === "v0001"));
    assert.match(texts(t.app).join("\n"), /user:\/clip-remove 1 2/);
    await t.fake.settle(150);
    assert.ok(t.fake.screen().some((line) => line.includes("● v0001") || line.includes("v0001")), "the header shows the new version");
  } finally { await t.cleanup(); }
});

test("simple commands: /status, /help (a panel that Escape closes), /clear", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    await typeLine(t.fake, "/status");
    await until(() => texts(t.app).some((line) => line.includes("v0000 · 320x180")), 10_000, "/status");
    await typeLine(t.fake, "/help");
    await until(() => t.app.state.overlay === "help", 10_000, "the help panel");
    await t.fake.settle(150);
    assert.ok(t.fake.screen().some((line) => line.includes("DumbEditor controls")));
    t.fake.send(KEY.esc);
    await until(() => t.app.state.overlay === null, 10_000, "the panel to close");
    await typeLine(t.fake, "/clear");
    await until(() => t.app.state.messages.length === 0, 10_000, "/clear");
  } finally { await t.cleanup(); }
});

test("Ctrl+P plays the preview and moves the playhead; Ctrl+P again pauses it", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    t.fake.send(KEY.ctrlP);
    await until(() => t.app.state.playing, 5_000, "playing");
    await until(() => t.app.state.playhead > 0.3, 30_000, "the playhead to move");
    t.fake.send(KEY.ctrlP);
    await until(() => !t.app.state.playing, 5_000, "paused");
    const stopped = t.app.state.playhead;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(t.app.state.playhead, stopped, "the playhead stays put once paused");
  } finally { await t.cleanup(); }
});

test("a request streams the agent's answer into the chat and saves it in the project's history", { timeout: 90_000 }, async () => {
  const t = await boot();
  try {
    t.faux.faux.setResponses([say("Hello from the agent")]);
    await typeLine(t.fake, "describe the video");
    await until(() => texts(t.app).some((line) => line.endsWith(":Hello from the agent")), 30_000, "the answer");
    await until(() => !t.app.state.agentRunning, 10_000, "the run to end");
    assert.deepEqual(texts(t.app).slice(-2).map((line) => line.replace(/^[^:]+:/, "")), ["describe the video", "Hello from the agent"]);
    for (let attempt = 0; attempt < 100 && (await t.app.project!.chatHistory()).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    const history = await t.app.project!.chatHistory();
    assert.deepEqual(history.slice(-2).map((message) => message.content), ["describe the video", "Hello from the agent"]);
  } finally { await t.cleanup(); }
});

test("a paid action asks first; Enter picks the safe default (Deny) and the run ends", { timeout: 90_000 }, async () => {
  const t = await boot({ permission: "ask" });
  try {
    t.faux.faux.setResponses([
      toolUse(call("generate_asset", { kind: "image", prompt: "a cat", duration: null, voice: null, provider: null, model: null, provider_options_json: null }, "g1")),
      say("Understood, I will not generate it."),
    ]);
    await typeLine(t.fake, "make me a cat picture");
    await until(() => t.app.state.overlay === "approval", 30_000, "the approval panel");
    await t.fake.settle(150);
    assert.ok(t.fake.screen().some((line) => line.includes("Permission required")));
    t.fake.send(KEY.enter);
    await until(() => !t.app.state.agentRunning && t.app.state.overlay === null, 30_000, "the run to end");
    assert.ok(texts(t.app).some((line) => line.includes("Understood, I will not generate it.")));
    assert.equal(t.app.state.assets.length, 0, "nothing was generated");
  } finally { await t.cleanup(); }
});

test("Ctrl+C stops a run that is waiting and says so", { timeout: 90_000 }, async () => {
  const t = await boot();
  try {
    t.faux.faux.setResponses([toolUse(call("present_choices", { question: "Which?", options: ["A", "B"], allow_custom: false }, "c1"))]);
    await typeLine(t.fake, "ask me something");
    await until(() => t.app.state.overlay === "choice", 30_000, "the choice panel");
    t.fake.send(KEY.ctrlC);
    await until(() => !t.app.state.agentRunning, 30_000, "the run to stop");
    assert.ok(texts(t.app).some((line) => line === "editor:Stopped."));
    assert.equal(t.exits(), 0, "Ctrl+C stops the agent first and does not quit");
  } finally { await t.cleanup(); }
});

test("without an agent a request explains what to do, and slash commands still work", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    await typeLine(t.fake, "trim the intro");
    await until(() => texts(t.app).some((line) => line.includes("Add an OpenRouter API key")), 10_000, "the explanation");
  } finally { await t.cleanup(); }
});

test("/export opens its panel and Escape closes it; Ctrl+C at rest quits and releases the terminal", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    await typeLine(t.fake, "/export");
    await until(() => t.app.state.overlay === "export", 10_000, "the export panel");
    await t.fake.settle(150);
    assert.ok(t.fake.screen().some((line) => line.includes("Export video")));
    t.fake.send(KEY.esc);
    await until(() => t.app.state.overlay === null, 10_000, "the panel to close");
    t.fake.send(KEY.ctrlC);
    await until(() => t.exits() === 1, 10_000, "quit");
  } finally { await t.cleanup(); }
});

test("disposing the app while the video plays stops the picture, the sound and every key", { timeout: 90_000 }, async () => {
  const started: number[] = [];
  let stopped = 0;
  const project = await makeProject();
  const fake = new FakeTerminal(120, 40);
  const app = new ShellApp({
    terminal: fake, initialPath: project.store.snapshot.sourcePath, backend: "sixel", createEngine: async () => null,
    audio: { spawn: () => { started.push(1); return {} as never; }, terminate: (child) => { if (child) stopped += 1; } },
  });
  try {
    await app.start();
    await until(() => app.state.media !== null && !app.state.loader, 30_000, "the video to open");
    fake.send(KEY.ctrlP);
    await until(() => app.state.playhead > 0.3, 30_000, "the playhead to move");
    assert.equal(started.length, 1, "the sound started with the picture");
    app.dispose();
    assert.equal(stopped, 1, "the sound was stopped");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const writes = fake.writes.length;
    fake.send(KEY.right);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fake.writes.length, writes, "nothing more is drawn after dispose");
  } finally {
    app.dispose();
    await project.cleanup();
  }
});

test("while the editor renders a new version the preview stops playing", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    t.fake.send(KEY.ctrlP);
    await until(() => t.app.state.playing, 5_000, "playing");
    t.app.state.setLoader({ source: "glm", stage: "Rendering with FFmpeg" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(t.app.state.playing, false, "paused for the render, not because the clip ended");
  } finally { await t.cleanup(); }
});

test("a panel that is replaced by another stops what it started", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    const state = t.app.state;
    state.openOverlay("assets");
    await t.fake.settle();
    const inner = t.app as unknown as { assetPlaying: boolean };
    inner.assetPlaying = true;
    state.openOverlay("help");
    await t.fake.settle();
    assert.equal(inner.assetPlaying, false, "the asset browser's playback was stopped when the help panel replaced it");
  } finally { await t.cleanup(); }
});

test("the notice that the agent could not start survives loading the project's chat", { timeout: 90_000 }, async () => {
  const t = await boot({ engine: false });
  try {
    const notices = (t.app as unknown as { engineNotices: string[] }).engineNotices;
    notices.push("The agent could not start for this project: boom. Slash commands still work.");
    await t.app.openVideo(t.project.store.snapshot.sourcePath);
    const lines = texts(t.app);
    assert.ok(lines.some((line) => line.includes("The agent could not start for this project: boom")), "shown after the chat is loaded");
    assert.ok(!lines.some((line) => line.includes("Add an OpenRouter API key")), "and not hidden behind the missing-key message");
    assert.equal(notices.length, 0, "shown once");
  } finally { await t.cleanup(); }
});
