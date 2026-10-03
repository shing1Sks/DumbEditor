import assert from "node:assert/strict";
import test from "node:test";
import { parseEncoders, parseFilters, type FfmpegCapabilities } from "../src/core/ffmpeg-capabilities.js";
import { buildReport, formatReport, gatherInputs, REQUIRED_FILTERS, type DoctorInputs } from "../src/platform/doctor.js";
import { installHints } from "../src/platform/hints.js";

const names = (list: readonly string[]) => list.map((name) => ` ... ${name}            V->V       x`).join("\n");
const filters = (extra: string[]) => parseFilters(`Filters:\n${names([...REQUIRED_FILTERS, ...extra])}\n`);
const encoders = parseEncoders(" V....D libx264              x\n A....D aac                  x\n");
const full: FfmpegCapabilities = { version: "7.1", filters: filters(["ass", "subtitles"]), encoders };
const slim: FfmpegCapabilities = { version: "9.0.2", filters: filters([]), encoders };

const base: DoctorInputs = {
  node: "v22.19.0", platform: "darwin", ffmpeg: full, ffprobe: true, ffplay: true, imageLibrary: true,
  painter: { id: "blocks", reason: "no Sixel support detected in this terminal" },
  sandbox: { available: true, detail: "Anthropic Sandbox Runtime" }, providerKey: true,
};
const byLabel = (report: ReturnType<typeof buildReport>, label: RegExp) => report.checks.find((check) => label.test(check.label));

test("a complete setup passes with no required failures", () => {
  const report = buildReport(base);
  assert.equal(report.ok, true);
  assert.equal(byLabel(report, /text/i)?.status, "ok");
  assert.match(byLabel(report, /text/i)?.detail ?? "", /libass/);
});

test("the Homebrew-slim FFmpeg passes through images when the image library is there, and warns when it is not", () => {
  const withLibrary = buildReport({ ...base, ffmpeg: slim });
  assert.equal(withLibrary.ok, true);
  assert.match(byLabel(withLibrary, /text/i)?.detail ?? "", /images/);
  const without = buildReport({ ...base, ffmpeg: slim, imageLibrary: false });
  assert.equal(without.ok, true, "text is optional");
  assert.equal(byLabel(without, /text/i)?.status, "warn");
  assert.ok((byLabel(without, /text/i)?.fix ?? []).join("\n").includes("ffmpeg-full"));
});

test("a missing FFmpeg fails with the install command for the OS and does not crash", () => {
  const report = buildReport({ ...base, ffmpeg: null, ffprobe: false, ffplay: false });
  assert.equal(report.ok, false);
  const ffmpeg = byLabel(report, /^ffmpeg$/i);
  assert.equal(ffmpeg?.status, "fail");
  assert.ok((ffmpeg?.fix ?? []).join("\n").includes("brew install ffmpeg-full"));
  assert.ok(formatReport(report).includes("[fail]"));
  const windows = buildReport({ ...base, platform: "win32", ffmpeg: null });
  assert.ok((byLabel(windows, /^ffmpeg$/i)?.fix ?? []).join("\n").includes("winget install Gyan.FFmpeg"));
});

test("missing encoders and filters are named", () => {
  const noEncoder: FfmpegCapabilities = { ...full, encoders: parseEncoders(" A....D aac  x\n") };
  const report = buildReport({ ...base, ffmpeg: noEncoder });
  assert.equal(report.ok, false);
  assert.match(byLabel(report, /encoders/i)?.detail ?? "", /libx264/);
  const noOverlay: FfmpegCapabilities = { ...full, filters: parseFilters(names(REQUIRED_FILTERS.filter((name) => name !== "overlay"))) };
  assert.match(byLabel(buildReport({ ...base, ffmpeg: noOverlay }), /filters/i)?.detail ?? "", /overlay/);
});

test("old Node fails; a missing ffplay, key, sandbox and a block-art terminal only warn", () => {
  assert.equal(buildReport({ ...base, node: "v20.11.0" }).ok, false);
  const report = buildReport({ ...base, ffplay: false, providerKey: false, sandbox: { available: false, detail: "bubblewrap is missing" } });
  assert.equal(report.ok, true);
  for (const label of [/ffplay/i, /provider|key/i, /sandbox/i, /terminal/i]) assert.equal(byLabel(report, label)?.status, "warn", String(label));
});

test("the report never contains a secret value", async () => {
  const secret = "sk-or-v1-supersecretvalue";
  const inputs = await gatherInputs({ OPENROUTER_API_KEY: secret });
  assert.equal(inputs.providerKey, true);
  const text = formatReport(buildReport(inputs));
  assert.ok(!text.includes(secret) && !/sk-or/.test(text));
  assert.match(text, /OPENROUTER_API_KEY is set/);
});

test("the real setup of this machine produces a report with the required checks", async () => {
  const report = buildReport(await gatherInputs({ WT_SESSION: "x" }));
  for (const label of [/^node$/i, /^ffmpeg$/i, /ffprobe/i, /encoders/i, /filters/i, /text/i, /ffplay/i, /terminal/i, /sandbox/i, /key/i]) assert.ok(byLabel(report, label), String(label));
  assert.equal(byLabel(report, /terminal/i)?.status, "ok", "WT_SESSION means a sharp Sixel picture");
});

test("install hints exist for every platform", () => {
  for (const platform of ["win32", "darwin", "linux", "freebsd"] as const) assert.ok(installHints(platform).length > 0, platform);
});
