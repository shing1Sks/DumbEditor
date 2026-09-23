import assert from "node:assert/strict";
import test from "node:test";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeDirectEdit } from "../src/core/editor.js";
import { probeMedia } from "../src/core/media.js";
import { runProcess } from "../src/core/process.js";
import { ProjectStore } from "../src/core/project.js";

test("edits a video, records a version, and reverts without deleting history", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-test-"));
  try {
    const source = join(directory, "source.mp4");
    await runProcess("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=4",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ], { timeoutMs: 60_000 });

    const store = await ProjectStore.open(source);
    const result = await executeDirectEdit(store, { action: "remove", ranges: [{ start: 3, end: 4 }, { start: 0, end: 1 }, { start: 0.5, end: 0.75 }] }, "remove ends");
    const firstEditPath = result.version.filePath;
    assert.equal(result.version.id, "v0001");
    assert.ok(result.media.duration > 1.8 && result.media.duration < 2.2);
    assert.equal(store.snapshot.versions.length, 2);

    const original = await store.revert("v0000");
    assert.equal(original.filePath, source);
    assert.equal(store.snapshot.versions.length, 2);
    assert.ok((await probeMedia(store.current.filePath)).duration > 3.9);

    const trim = await executeDirectEdit(store, { action: "trim", range: { start: 0.5, end: 2.5 } }, "keep middle");
    assert.equal(trim.version.id, "v0002");
    assert.equal(trim.version.parentId, "v0000");
    assert.ok(trim.media.duration > 1.9 && trim.media.duration < 2.1);
    assert.deepEqual(store.history(2).map(({ id }) => id), ["v0002", "v0001"]);
    assert.deepEqual(store.history(0), []);

    await store.revert("0");
    const speed = await executeDirectEdit(store, { action: "speed", range: { start: 1, end: 3 }, factor: 2 }, "speed middle");
    assert.ok(speed.media.duration > 2.9 && speed.media.duration < 3.1);

    await store.revert("v0000");
    const muted = await executeDirectEdit(store, { action: "mute", range: { start: 1, end: 2 } }, "mute one second");
    assert.ok(muted.media.duration > 3.9 && muted.media.duration < 4.1);
    assert.equal(muted.media.hasAudio, true);
    assert.ok(await audioPeak(muted.version.filePath, 0.2, 0.4) > 1_000);
    assert.ok(await audioPeak(muted.version.filePath, 1.2, 0.4) < 100);

    await store.revert("v0000");
    const cropped = await executeDirectEdit(store, { action: "crop", width: 161, height: 91 }, "crop center");
    assert.equal(cropped.media.width, 160);
    assert.equal(cropped.media.height, 90);

    await assert.rejects(
      executeDirectEdit(store, { action: "crop", width: 100, height: 50, x: 100, y: 0 }, "bad crop"),
      /exceeds the 160px video width/,
    );
    assert.equal(store.snapshot.versions.length, 6);

    const sixthPath = store.nextOutputPath();
    await copyFile(cropped.version.filePath, sixthPath);
    await store.commit({ outputPath: sixthPath, action: "Checkpoint", request: "retention check", duration: cropped.media.duration });
    assert.equal(store.snapshot.versions.length, 6);
    assert.equal(store.snapshot.versions.some((version) => version.id === "v0001"), false);
    await assert.rejects(access(firstEditPath));

    await store.setVersionLimit(2);
    assert.equal(store.versionLimit, 2);
    assert.equal(store.snapshot.versions.length, 3);
    assert.equal(store.current.id, "v0006");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function audioPeak(filePath: string, start: number, duration: number): Promise<number> {
  const result = await runProcess("ffmpeg", [
    "-v", "error", "-ss", String(start), "-t", String(duration), "-i", filePath,
    "-map", "0:a:0", "-ac", "1", "-f", "s16le", "-c:a", "pcm_s16le", "pipe:1",
  ], { timeoutMs: 20_000, maxOutputBytes: 1_000_000 });
  let peak = 0;
  for (let offset = 0; offset + 1 < result.stdout.length; offset += 2) {
    peak = Math.max(peak, Math.abs(result.stdout.readInt16LE(offset)));
  }
  return peak;
}
