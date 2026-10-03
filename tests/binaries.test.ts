import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ffmpegDirectory, ffmpegDirectoryProblem, resolveBinary, type BinaryContext } from "../src/core/binaries.js";
import { loadEnvironment } from "../src/core/config.js";
import { playAudio, streamRawPreview } from "../src/core/media.js";
import { runProcess, spawnQuiet } from "../src/core/process.js";

/** A context whose "files" are exactly the paths given, compared as the code builds them with join and resolve. */
const context = (over: Partial<BinaryContext> & { files?: string[] } = {}): BinaryContext => ({
  env: over.env ?? {},
  platform: over.platform ?? "linux",
  exists: (path) => (over.files ?? []).includes(path),
});
const inside = (directory: string, name: string) => join(resolve(directory), name);

test("without a setting the bare names are used, as always", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    for (const name of ["ffmpeg", "ffprobe", "ffplay"]) assert.equal(resolveBinary(name, context({ platform })), name, `${platform} ${name}`);
  }
});

test("DUMBEDITOR_FFMPEG_DIR picks the tools from that folder, and only the FFmpeg tools", () => {
  const files = ["ffmpeg", "ffprobe", "ffplay"].map((name) => inside("/opt/ff", name));
  const env = { DUMBEDITOR_FFMPEG_DIR: " /opt/ff " };
  assert.equal(resolveBinary("ffmpeg", context({ env, files })), inside("/opt/ff", "ffmpeg"));
  assert.equal(resolveBinary("ffplay", context({ env, files })), inside("/opt/ff", "ffplay"));
  for (const other of ["python3", "powershell", "where.exe", "which", "git"]) assert.equal(resolveBinary(other, context({ env, files })), other);
});

test("a relative folder is made absolute, so it means the same wherever a program is started", () => {
  const files = [inside("bin", "ffmpeg")];
  const result = resolveBinary("ffmpeg", context({ env: { DUMBEDITOR_FFMPEG_DIR: "bin" }, files }));
  assert.equal(result, inside("bin", "ffmpeg"));
  assert.equal(resolve(result), result, "absolute");
});

test("Windows file names end in .exe", () => {
  const files = [inside("C:/ff", "ffmpeg.exe")];
  assert.equal(resolveBinary("ffmpeg", context({ platform: "win32", env: { DUMBEDITOR_FFMPEG_DIR: "C:/ff" }, files })), inside("C:/ff", "ffmpeg.exe"));
});

test("a folder that lacks the tool falls back to PATH instead of failing", () => {
  const env = { DUMBEDITOR_FFMPEG_DIR: "/opt/ff" };
  assert.equal(resolveBinary("ffplay", context({ env, files: [inside("/opt/ff", "ffmpeg")] })), "ffplay");
  assert.equal(resolveBinary("ffmpeg", context({ env, files: [] })), "ffmpeg");
});

test("on macOS Homebrew's ffmpeg-full is used when it is installed, and only there", () => {
  const apple = join("/opt/homebrew/opt/ffmpeg-full/bin", "ffmpeg");
  const intel = join("/usr/local/opt/ffmpeg-full/bin", "ffmpeg");
  assert.equal(ffmpegDirectory(context({ platform: "darwin", files: [apple] })), "/opt/homebrew/opt/ffmpeg-full/bin");
  assert.equal(ffmpegDirectory(context({ platform: "darwin", files: [intel] })), "/usr/local/opt/ffmpeg-full/bin");
  assert.equal(ffmpegDirectory(context({ platform: "darwin", files: [] })), null);
  assert.equal(ffmpegDirectory(context({ platform: "linux", files: [apple, intel] })), null, "not on Linux");
  assert.equal(ffmpegDirectory(context({ platform: "win32", files: [apple, intel] })), null, "not on Windows");
  assert.equal(ffmpegDirectory(context({ platform: "darwin", env: { DUMBEDITOR_FFMPEG_DIR: "/mine" }, files: [apple] })), resolve("/mine"), "the setting wins");
});

test("a bad DUMBEDITOR_FFMPEG_DIR is explained", () => {
  assert.equal(ffmpegDirectoryProblem(context()), null);
  assert.equal(ffmpegDirectoryProblem(context({ env: { DUMBEDITOR_FFMPEG_DIR: "/opt/ff" }, files: [inside("/opt/ff", "ffmpeg")] })), null);
  assert.match(ffmpegDirectoryProblem(context({ env: { DUMBEDITOR_FFMPEG_DIR: "/opt/ff" } })) ?? "", /DUMBEDITOR_FFMPEG_DIR is \/opt\/ff/);
});

/** A folder whose "ffmpeg" and "ffplay" are really copies of node, so what ran can be told from the real FFmpeg. */
async function fakeToolFolder(): Promise<{ directory: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-fakebin-"));
  const suffix = process.platform === "win32" ? ".exe" : "";
  for (const name of ["ffmpeg", "ffplay"]) {
    const file = join(directory, `${name}${suffix}`);
    await copyFile(process.execPath, file);
    await chmod(file, 0o755);
  }
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function withFolder<T>(directory: string, body: () => Promise<T>): Promise<T> {
  const saved = process.env.DUMBEDITOR_FFMPEG_DIR;
  process.env.DUMBEDITOR_FFMPEG_DIR = directory;
  try { return await body(); } finally {
    if (saved === undefined) delete process.env.DUMBEDITOR_FFMPEG_DIR; else process.env.DUMBEDITOR_FFMPEG_DIR = saved;
  }
}

test("runProcess, spawnQuiet, the preview stream and the sound player all run the program from the chosen folder", { timeout: 60_000 }, async () => {
  const fake = await fakeToolFolder();
  try {
    await withFolder(fake.directory, async () => {
      const ran = await runProcess("ffmpeg", ["-p", "'from-the-folder'"], { timeoutMs: 20_000, maxOutputBytes: 10_000 });
      assert.equal(ran.stdout.toString("utf8").trim(), "from-the-folder", "runProcess");

      const output = await new Promise<string>((done, fail) => {
        const child = spawnQuiet("ffplay", ["-p", "'quiet-from-the-folder'"]);
        let text = "";
        child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
        child.once("error", fail);
        child.once("close", () => done(text));
      });
      assert.equal(output.trim(), "quiet-from-the-folder", "spawnQuiet");

      // The real FFmpeg would complain about the missing file. The stand-in is node, which reads "-v" as "print the
      // version" and exits cleanly, so the stream simply ends without an error.
      const stream = await new Promise<{ ended: boolean; error: Error | null }>((done) => {
        streamRawPreview({
          filePath: "missing.mp4", start: 0, size: { width: 4, height: 4 }, onFrame: () => undefined,
          onEnd: () => done({ ended: true, error: null }), onError: (error) => done({ ended: false, error }),
        });
      });
      assert.deepEqual(stream.error, null, "streamRawPreview ran the stand-in, which did not fail on a missing file");
      assert.equal(stream.ended, true);

      // And node rejects "-nodisp" as an option, which the real ffplay would accept.
      const soundError = await new Promise<Error>((done) => { playAudio("missing.mp3", 0, 100, done); });
      assert.match(soundError.message, /bad option/i, "playAudio");
    });
  } finally { await fake.cleanup(); }
});

test("without the setting a folder with a fake ffmpeg is simply not used", { timeout: 30_000 }, async () => {
  const fake = await fakeToolFolder();
  try {
    const saved = process.env.DUMBEDITOR_FFMPEG_DIR;
    delete process.env.DUMBEDITOR_FFMPEG_DIR;
    try {
      const result = await runProcess("ffmpeg", ["-version"], { timeoutMs: 15_000, maxOutputBytes: 64_000 });
      assert.match(result.stdout.toString("utf8"), /^ffmpeg version/);
    } finally { if (saved !== undefined) process.env.DUMBEDITOR_FFMPEG_DIR = saved; }
  } finally { await fake.cleanup(); }
});

test("a .env file in the current folder cannot choose which program runs, but still sets other values", async () => {
  const folder = await mkdtemp(join(tmpdir(), "dumbeditor-dotenv-"));
  const emptyRoot = await mkdtemp(join(tmpdir(), "dumbeditor-root-"));
  const savedDirectory = process.cwd();
  const savedFolder = process.env.DUMBEDITOR_FFMPEG_DIR;
  delete process.env.DUMBEDITOR_FFMPEG_DIR;
  delete process.env.DUMBEDITOR_TEST_FROM_DOTENV;
  try {
    await writeFile(join(folder, ".env"), "DUMBEDITOR_FFMPEG_DIR=./evil\nDUMBEDITOR_TEST_FROM_DOTENV=yes\n", "utf8");
    process.chdir(folder);
    loadEnvironment(emptyRoot);
    assert.notEqual(process.env.DUMBEDITOR_FFMPEG_DIR, "./evil", "the program folder did not come from the .env in the current folder");
    assert.equal(process.env.DUMBEDITOR_TEST_FROM_DOTENV, "yes", "other settings still do");
  } finally {
    process.chdir(savedDirectory);
    delete process.env.DUMBEDITOR_TEST_FROM_DOTENV;
    if (savedFolder === undefined) delete process.env.DUMBEDITOR_FFMPEG_DIR; else process.env.DUMBEDITOR_FFMPEG_DIR = savedFolder;
    await rm(folder, { recursive: true, force: true });
    await rm(emptyRoot, { recursive: true, force: true });
  }
});
