import assert from "node:assert/strict";
import test from "node:test";
import { ffmpegDirectory, ffmpegDirectoryProblem, resolveBinary, type BinaryContext } from "../src/core/binaries.js";
import { runProcess } from "../src/core/process.js";

const context = (over: Partial<BinaryContext> & { files?: string[] } = {}): BinaryContext => ({
  env: over.env ?? {},
  platform: over.platform ?? "linux",
  exists: (path) => (over.files ?? []).includes(path.replace(/\\/g, "/")),
});

test("without a setting the bare names are used, as always", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const name of ["ffmpeg", "ffprobe", "ffplay"]) assert.equal(resolveBinary(name, context({ platform })), name, `${platform} ${name}`);
  }
});

test("DUMBEDITOR_FFMPEG_DIR picks the tools from that folder, and only the FFmpeg tools", () => {
  const files = ["/opt/ff/ffmpeg", "/opt/ff/ffprobe", "/opt/ff/ffplay"];
  const env = { DUMBEDITOR_FFMPEG_DIR: " /opt/ff " };
  assert.equal(resolveBinary("ffmpeg", context({ env, files })).replace(/\\/g, "/"), "/opt/ff/ffmpeg");
  assert.equal(resolveBinary("ffplay", context({ env, files })).replace(/\\/g, "/"), "/opt/ff/ffplay");
  for (const other of ["python3", "powershell", "where.exe", "which", "git"]) assert.equal(resolveBinary(other, context({ env, files })), other);
});

test("Windows file names end in .exe", () => {
  const files = ["C:/ff/ffmpeg.exe"];
  assert.match(resolveBinary("ffmpeg", context({ platform: "win32", env: { DUMBEDITOR_FFMPEG_DIR: "C:/ff" }, files })).replace(/\\/g, "/"), /C:\/ff\/ffmpeg\.exe$/);
});

test("a folder that lacks the tool falls back to PATH instead of failing", () => {
  const env = { DUMBEDITOR_FFMPEG_DIR: "/opt/ff" };
  assert.equal(resolveBinary("ffplay", context({ env, files: ["/opt/ff/ffmpeg"] })), "ffplay");
  assert.equal(resolveBinary("ffmpeg", context({ env, files: [] })), "ffmpeg");
});

test("on macOS Homebrew's ffmpeg-full is used when it is installed, and only there", () => {
  const apple = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
  const intel = "/usr/local/opt/ffmpeg-full/bin/ffmpeg";
  assert.equal(ffmpegDirectory(context({ platform: "darwin", files: [apple] })), "/opt/homebrew/opt/ffmpeg-full/bin");
  assert.equal(ffmpegDirectory(context({ platform: "darwin", files: [intel] })), "/usr/local/opt/ffmpeg-full/bin");
  assert.equal(ffmpegDirectory(context({ platform: "darwin", files: [] })), null);
  assert.equal(ffmpegDirectory(context({ platform: "linux", files: [apple, intel] })), null, "not on Linux");
  assert.equal(ffmpegDirectory(context({ platform: "win32", files: [apple, intel] })), null, "not on Windows");
  assert.equal(ffmpegDirectory(context({ platform: "darwin", env: { DUMBEDITOR_FFMPEG_DIR: "/mine" }, files: [apple] })), "/mine", "the setting wins");
});

test("a bad DUMBEDITOR_FFMPEG_DIR is explained", () => {
  assert.equal(ffmpegDirectoryProblem(context()), null);
  assert.equal(ffmpegDirectoryProblem(context({ env: { DUMBEDITOR_FFMPEG_DIR: "/opt/ff" }, files: ["/opt/ff/ffmpeg"] })), null);
  assert.match(ffmpegDirectoryProblem(context({ env: { DUMBEDITOR_FFMPEG_DIR: "/opt/ff" } })) ?? "", /DUMBEDITOR_FFMPEG_DIR is \/opt\/ff/);
});

test("runProcess runs the program from the chosen folder", async () => {
  // A folder that has no ffmpeg at all is ignored, so the real FFmpeg on PATH still answers.
  const saved = process.env.DUMBEDITOR_FFMPEG_DIR;
  process.env.DUMBEDITOR_FFMPEG_DIR = "/definitely/not/here";
  try {
    const result = await runProcess("ffmpeg", ["-version"], { timeoutMs: 15_000, maxOutputBytes: 64_000 });
    assert.match(result.stdout.toString("utf8"), /^ffmpeg version/);
  } finally {
    if (saved === undefined) delete process.env.DUMBEDITOR_FFMPEG_DIR; else process.env.DUMBEDITOR_FFMPEG_DIR = saved;
  }
});
