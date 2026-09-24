import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDestination, exportVideo } from "../src/core/export.js";
import { runProcess } from "../src/core/process.js";

test("exports MP4 and MKV with selectable compression", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-export-"));
  try {
    const source = join(directory, "source.mp4");
    await runProcess("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-crf", "14", "-c:a", "aac", "-shortest", source,
    ], { timeoutMs: 30_000 });

    const high = await exportVideo({ input: source, destination: join(directory, "high"), format: "mp4", preset: "high" });
    const compact = await exportVideo({ input: source, destination: join(directory, "compact.mp4"), format: "mkv", preset: "compact" });

    assert.match(high.path, /high\.mp4$/);
    assert.match(compact.path, /compact\.mkv$/);
    assert.equal(high.media.width, 320);
    assert.equal(compact.media.height, 180);
    assert.equal(high.media.hasAudio, true);
    assert.equal(compact.media.hasAudio, true);
    assert.ok(high.media.duration > 2.9 && high.media.duration < 3.1);
    assert.ok(compact.bytes < high.bytes, `compact ${compact.bytes} should be smaller than high ${high.bytes}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normalizes export extensions and protects the active file", async () => {
  const source = join(tmpdir(), "clips", "demo.mov");
  assert.equal(exportDestination(source, join(tmpdir(), "out", "final.mp4"), "mkv"), join(tmpdir(), "out", "final.mkv"));
  assert.match(exportDestination(source, join(tmpdir(), "out", "final"), "mp4"), /final\.mp4$/);
  const active = join(tmpdir(), "clips", "active.mp4");
  await assert.rejects(
    exportVideo({ input: active, destination: active, format: "mp4", preset: "copy" }),
    /different from the active video/,
  );
});
