import assert from "node:assert/strict";
import test from "node:test";
import { cellSize, setMeasuredCell } from "../src/shell/preview/painters/cell-size.js";
import { detectPainter } from "../src/shell/preview/painters/detect.js";
import type { ProbeResult } from "../src/shell/preview/painters/probe.js";

const answer = (extra: Partial<ProbeResult>): ProbeResult => ({ kitty: false, sixel: false, cell: null, name: null, ...extra });

async function run(env: NodeJS.ProcessEnv, options: { platform?: NodeJS.Platform; isTTY?: boolean; result?: ProbeResult | null } = {}) {
  let asked = 0;
  const detected = await detectPainter({
    env, platform: options.platform ?? "darwin", isTTY: options.isTTY ?? true,
    probe: async () => { asked += 1; return options.result === undefined ? null : options.result; },
  });
  return { ...detected, asked };
}

test("Windows never asks the terminal and keeps its rule", async () => {
  for (const env of [{ WT_SESSION: "x" }, {}, { TERM: "xterm-sixel" }, { TERM_PROGRAM: "WezTerm" }] as NodeJS.ProcessEnv[]) {
    const result = await run(env, { platform: "win32", result: answer({ kitty: true }) });
    assert.equal(result.asked, 0, JSON.stringify(env));
  }
  assert.equal((await run({ WT_SESSION: "x" }, { platform: "win32" })).id, "sixel");
  assert.equal((await run({}, { platform: "win32" })).id, "blocks");
});

test("an explicit setting wins everywhere, Windows included, without asking", async () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    for (const setting of ["blocks", "sixel", "kitty"] as const) {
      const result = await run({ DUMBEDITOR_PREVIEW: ` ${setting.toUpperCase()} ` }, { platform, result: answer({ kitty: true }) });
      assert.deepEqual([result.id, result.asked], [setting, 0], `${platform} ${setting}`);
    }
  }
  const auto = await run({ DUMBEDITOR_PREVIEW: "auto" }, { result: answer({ sixel: true }) });
  assert.deepEqual([auto.id, auto.asked], ["sixel", 1], "auto means ask");
});

test("Terminal.app, tmux, screen and a non-terminal are never asked", async () => {
  const cases: Array<[NodeJS.ProcessEnv, boolean]> = [
    [{ TERM_PROGRAM: "Apple_Terminal" }, true],
    [{ TMUX: "/tmp/tmux-501/default,1,0" }, true],
    [{ TERM: "tmux-256color" }, true],
    [{ TERM: "screen-256color" }, true],
    [{ TERM_PROGRAM: "ghostty" }, false],
  ];
  for (const [env, isTTY] of cases) {
    const result = await run(env, { isTTY, result: answer({ kitty: true }) });
    assert.equal(result.asked, 0, JSON.stringify(env));
    assert.equal(result.id, "blocks", `${JSON.stringify(env)} falls back to the old rule`);
  }
});

test("a terminal that answers is believed: Kitty first, then Sixel, then block art", async () => {
  assert.equal((await run({}, { result: answer({ kitty: true, sixel: true, name: "WezTerm 2024" }) })).id, "kitty");
  assert.equal((await run({}, { result: answer({ kitty: true }) })).id, "kitty");
  assert.equal((await run({}, { result: answer({ sixel: true, name: "foot(1.18)" }) })).id, "sixel");
  const gnome = await run({}, { result: answer({ name: "VTE 7600" }) });
  assert.equal(gnome.id, "blocks");
  assert.equal(gnome.probed?.name, "VTE 7600", "what it said is kept");
});

test("a terminal that does not answer in time still gets Kitty when the environment says it has it", async () => {
  for (const env of [{ KITTY_WINDOW_ID: "1" }, { TERM: "xterm-kitty" }, { TERM: "xterm-ghostty" }, { TERM_PROGRAM: "ghostty" }, { TERM_PROGRAM: "WezTerm" }] as NodeJS.ProcessEnv[]) {
    assert.equal((await run(env)).id, "kitty", JSON.stringify(env));
  }
  assert.equal((await run({ TERM: "xterm-256color" })).id, "blocks");
});

test("an answer that says no beats the environment hint", async () => {
  assert.equal((await run({ TERM_PROGRAM: "ghostty" }, { result: answer({}) })).id, "blocks");
});

test("every choice comes with a reason a user can read", async () => {
  for (const result of [
    await run({}, { result: answer({ kitty: true, name: "ghostty 1.0" }) }),
    await run({}, { result: answer({ sixel: true }) }),
    await run({}),
    await run({ WT_SESSION: "x" }, { platform: "win32" }),
  ]) assert.ok(result.reason.length > 10, result.reason);
});

test("the measured cell size is used unless the environment says otherwise, and can be forgotten", () => {
  assert.deepEqual(cellSize({}), { width: 10, height: 20 });
  setMeasuredCell({ width: 17, height: 34 });
  try {
    assert.deepEqual(cellSize({}), { width: 17, height: 34 });
    assert.deepEqual(cellSize({ DUMBEDITOR_CELL_WIDTH: "8" }), { width: 8, height: 34 }, "the environment wins per side");
    assert.deepEqual(cellSize({ DUMBEDITOR_CELL_WIDTH: "x", DUMBEDITOR_CELL_HEIGHT: "-1" }), { width: 17, height: 34 });
  } finally { setMeasuredCell(null); }
  assert.deepEqual(cellSize({}), { width: 10, height: 20 });
  setMeasuredCell({ width: 0, height: 5 });
  assert.deepEqual(cellSize({}), { width: 10, height: 20 }, "a zero size is ignored");
});
