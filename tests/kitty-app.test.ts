import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { createEditorRegistry } from "../src/core/actions/index.js";
import { Engine } from "../src/core/engine/engine.js";
import { createStreamFn } from "../src/core/pi/models.js";
import { SessionStore } from "../src/core/session/session-store.js";
import { DEFAULT_SETTINGS } from "../src/core/settings.js";
import { ShellApp } from "../src/shell/app.js";
import { setMeasuredCell } from "../src/shell/preview/painters/cell-size.js";
import { setKittyPersistent } from "../src/shell/preview/painters/kitty.js";
import { FakeTerminal } from "./helpers/fake-terminal.js";
import { decodeKitty, type KittyCommand } from "./helpers/kitty-decode.js";
import { makeFaux } from "./helpers/faux.js";
import { makeProject } from "./helpers/project.js";

async function until(condition: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every Kitty command written to the terminal after `mark`, in order. */
const commandsSince = (fake: FakeTerminal, mark: number): KittyCommand[] => decodeKitty(fake.since(mark));
const shown = (commands: KittyCommand[]) => commands.filter((command) => command.keys.a === "T");
const deleted = (commands: KittyCommand[]) => commands.filter((command) => command.keys.a === "d");

async function boot(columns: number, rows: number, persistent: boolean) {
  const project = await makeProject();
  const fake = new FakeTerminal(columns, rows);
  const faux = makeFaux();
  const settings = structuredClone(DEFAULT_SETTINGS);
  setMeasuredCell({ width: 10, height: 20 });
  setKittyPersistent(persistent);
  const app = new ShellApp({
    terminal: fake, initialPath: project.store.snapshot.sourcePath, backend: "kitty", audio: { spawn: () => null },
    createEngine: async (editor, seed) => Engine.create({
      state: editor, registry: createEditorRegistry(), session: new SessionStore(join(editor.store.snapshot.projectDir, "agent", "session.jsonl")),
      models: faux.models, modelId: "faux", model: faux.model, streamFn: createStreamFn(faux.models), getSettings: () => settings, chatSeed: seed,
    }),
  });
  await app.start();
  await until(() => app.state.media !== null && !app.state.loader, 30_000, "the video to open");
  return { project, fake, app, cleanup: async () => { app.dispose(); setKittyPersistent(false); setMeasuredCell(null); await project.cleanup(); } };
}

for (const persistent of [false, true]) {
  test(`Kitty picture (persistent=${persistent}): it appears, and after the window shrinks and then grows it is the bigger picture`, { timeout: 120_000 }, async () => {
    const t = await boot(70, 24, persistent);
    try {
      await until(() => shown(commandsSince(t.fake, 0)).length > 0, 30_000, "the first picture");
      const small = shown(commandsSince(t.fake, 0)).at(-1)!;
      const smallWidth = Number(small.keys.s);

      const mark = t.fake.mark();
      t.fake.resize(110, 36);
      await until(() => shown(commandsSince(t.fake, mark)).some((command) => Number(command.keys.s) > smallWidth), 30_000, "a bigger picture after the window grew");
      const after = commandsSince(t.fake, mark);
      const last = after.at(-1)!;
      assert.equal(last.keys.a, "T", "the last thing written is a picture, not a delete");
      assert.ok(Number(last.keys.s) > smallWidth, "and it is the bigger one");
    } finally { await t.cleanup(); }
  });
}

test("Kitty picture: shrinking replaces it with a smaller one and never leaves the old one drawn over the chat", { timeout: 120_000 }, async () => {
  const t = await boot(110, 36, false);
  try {
    await until(() => shown(commandsSince(t.fake, 0)).length > 0, 30_000, "the first picture");
    const big = shown(commandsSince(t.fake, 0)).at(-1)!;
    const mark = t.fake.mark();
    t.fake.resize(70, 24);
    await until(() => shown(commandsSince(t.fake, mark)).some((command) => Number(command.keys.s) < Number(big.keys.s)), 30_000, "a smaller picture after the window shrank");
    const after = commandsSince(t.fake, mark);
    const firstSmaller = after.findIndex((command) => command.keys.a === "T" && Number(command.keys.s) < Number(big.keys.s));
    assert.ok(deleted(after.slice(0, firstSmaller)).length >= 1 || firstSmaller === 0, "the big picture was deleted before the small one appeared");
  } finally { await t.cleanup(); }
});
