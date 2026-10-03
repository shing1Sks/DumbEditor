import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PROBE_QUERY, parseProbeReply, probeTerminal, stdioTransport, type ProbeTransport } from "../src/shell/preview/painters/probe.js";

const ESC = "\u001B";
const KITTY_OK = `${ESC}_Gi=31;OK${ESC}\\`;
const cell = (height: number, width: number) => `${ESC}[6;${height};${width}t`;
const name = (text: string) => `${ESC}P>|${text}${ESC}\\`;
const da1 = (attributes: string) => `${ESC}[?${attributes}c`;

// Replies as these terminals send them (the shape matters, the exact numbers are typical).
const REPLIES = {
  kitty: `${KITTY_OK}${cell(38, 19)}${name("kitty(0.35.2)")}${da1("62;c")}`,
  ghostty: `${KITTY_OK}${cell(34, 17)}${name("ghostty 1.0.1")}${da1("62;22c")}`,
  wezterm: `${KITTY_OK}${cell(36, 18)}${name("WezTerm 20240203-110809")}${da1("65;4;6;18;22c")}`,
  iterm2: `${KITTY_OK}${cell(36, 18)}${name("iTerm2 3.6.2")}${da1("62;4;22c")}`,
  foot: `${cell(32, 16)}${name("foot(1.18.1)")}${da1("62;4;22c")}`,
  xtermSixel: `${cell(16, 8)}${name("XTerm(388)")}${da1("64;1;2;4;6;9;15;22c")}`,
  vscode: `${cell(34, 17)}${da1("61;4;6;7;14;21;22;23;24;28;32;42c")}`,
  gnome: `${cell(34, 17)}${name("VTE 7600")}${da1("65;1;9c")}`,
  bare: da1("1;2c"),
};

test("kitty, Ghostty, WezTerm and iTerm2 say they have Kitty graphics", () => {
  for (const key of ["kitty", "ghostty", "wezterm", "iterm2"] as const) assert.equal(parseProbeReply(REPLIES[key])?.kitty, true, key);
});

test("Sixel comes from attribute 4 of the device attributes, and only from there", () => {
  for (const key of ["wezterm", "iterm2", "foot", "xtermSixel", "vscode"] as const) assert.equal(parseProbeReply(REPLIES[key])?.sixel, true, key);
  for (const key of ["kitty", "ghostty", "gnome", "bare"] as const) assert.equal(parseProbeReply(REPLIES[key])?.sixel, false, key);
  assert.equal(parseProbeReply(da1("62;14;24c"))?.sixel, false, "14 and 24 are not 4");
});

test("the cell size and the name are read, and are absent when the terminal did not send them", () => {
  assert.deepEqual(parseProbeReply(REPLIES.ghostty)?.cell, { width: 17, height: 34 });
  assert.equal(parseProbeReply(REPLIES.ghostty)?.name, "ghostty 1.0.1");
  assert.equal(parseProbeReply(REPLIES.bare)?.cell, null);
  assert.equal(parseProbeReply(REPLIES.bare)?.name, null);
  assert.equal(parseProbeReply(`${cell(0, 0)}${da1("62c")}`)?.cell, null, "a zero size is not a size");
  assert.equal(parseProbeReply(`${cell(9000, 9000)}${da1("62c")}`)?.cell, null, "nor is an absurd one");
});

test("there is no answer until the device-attributes reply has arrived", () => {
  assert.equal(parseProbeReply(""), null);
  assert.equal(parseProbeReply(`${KITTY_OK}${cell(38, 19)}`), null);
  assert.equal(parseProbeReply(`${KITTY_OK}${ESC}[?62`), null, "a reply cut in half");
});

test("a terminal that says no to Kitty graphics is not counted as having them", () => {
  assert.equal(parseProbeReply(`${ESC}_Gi=31;ENOTSUPPORTED:nope${ESC}\\${da1("62c")}`)?.kitty, false);
});

function fakeTerminal(reply: string | null, chunkSize = reply?.length ?? 1) {
  const listeners = new Set<(data: string) => void>();
  const written: string[] = [];
  const transport: ProbeTransport = {
    write(data) {
      written.push(data);
      if (reply === null) return;
      let offset = 0;
      const send = () => {
        for (const listener of [...listeners]) listener(reply.slice(offset, offset + chunkSize));
        offset += chunkSize;
        if (offset < reply.length) setImmediate(send);
      };
      setImmediate(send);
    },
    onData(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { transport, written, listeners };
}

test("probing writes the query once and resolves with the parsed answer, even when it arrives in pieces", async () => {
  const { transport, written, listeners } = fakeTerminal(REPLIES.wezterm, 7);
  const result = await probeTerminal(transport, 500, { settleMs: 5, lateMs: 10 });
  assert.deepEqual(written, [PROBE_QUERY]);
  assert.equal(result?.kitty, true);
  assert.equal(result?.sixel, true);
  assert.equal(listeners.size, 0, "stopped listening");
});

test("garbage before the reply does not matter", async () => {
  const { transport } = fakeTerminal(`xx\u001B[Z${REPLIES.kitty}`);
  assert.equal((await probeTerminal(transport, 500, { settleMs: 5, lateMs: 10 }))?.kitty, true);
});

test("a terminal that never answers gives null after the timeout, and stops listening", async () => {
  const { transport, listeners } = fakeTerminal(null);
  const started = Date.now();
  assert.equal(await probeTerminal(transport, 30, { lateMs: 20 }), null);
  assert.ok(Date.now() - started >= 45, "waited for the timeout and the late window");
  assert.equal(listeners.size, 0);
});

test("the probe keeps listening through the late window after a timeout, then lets go, and uses a reply that arrives in it", async () => {
  const { transport, listeners } = fakeTerminal(null);
  const pending = probeTerminal(transport, 20, { lateMs: 80 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(listeners.size, 1, "still listening 30 ms after the timeout: a late reply must not reach the editor");
  for (const listener of [...listeners]) listener(REPLIES.kitty);
  const result = await pending;
  assert.equal(result?.kitty, true, "the late reply completed the answer, so it is used");
  assert.equal(listeners.size, 0, "and then the probe lets go");
});

test("a Kitty reply that arrives just after the device attributes is still counted", async () => {
  const { transport, listeners } = fakeTerminal(null);
  const pending = probeTerminal(transport, 500, { settleMs: 40 });
  for (const listener of [...listeners]) listener(da1("62;22c"));
  setTimeout(() => { for (const listener of [...listeners]) listener(KITTY_OK); }, 10);
  const result = await pending;
  assert.equal(result?.kitty, true);
  assert.equal(listeners.size, 0);
});

test("the real transport turns raw input on for the probe and restores exactly what it found", () => {
  for (const [raw, paused] of [[false, true], [true, false], [false, false]] as const) {
    const stdin = Object.assign(new EventEmitter(), {
      isRaw: raw, paused,
      setRawMode(mode: boolean) { this.isRaw = mode; return this; },
      isPaused() { return this.paused; },
      resume() { this.paused = false; return this; },
      pause() { this.paused = true; return this; },
    });
    const output: string[] = [];
    const transport = stdioTransport(stdin as never, { write: (data: string) => { output.push(data); } });
    assert.equal(stdin.isRaw, true, "raw during the probe");
    const seen: string[] = [];
    const stop = transport.onData((data) => seen.push(data));
    transport.write("hello");
    stdin.emit("data", Buffer.from("reply"));
    assert.deepEqual([output, seen], [["hello"], ["reply"]]);
    stop();
    transport.restore();
    assert.equal(stdin.isRaw, raw, "raw as before");
    assert.equal(stdin.paused, paused, "paused as before");
    assert.equal(stdin.listenerCount("data"), 0, "no listener left behind");
  }
});
