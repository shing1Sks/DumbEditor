import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeAdvancedEdit } from "../src/core/advanced-editor.js";
import { AgentWorkspace } from "../src/core/agent-workspace.js";
import { executeCustomRender } from "../src/core/custom-render.js";
import { probeMedia } from "../src/core/media.js";
import { runProcess } from "../src/core/process.js";
import { ProjectStore } from "../src/core/project.js";

test("renders local overlays, ranged effects, fades, and looped trimmed music", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-advanced-"));
  try {
    const source = join(directory, "source.mp4");
    const music = join(directory, "music.wav");
    const image = join(directory, "overlay.ppm");
    const subtitles = join(directory, "captions.srt");
    await createFixtures({ source, music, image, subtitles });

    const store = await ProjectStore.open(source);
    await store.setVersionLimit(10);

    const text = await executeAdvancedEdit(store, {
      action: "text",
      text: "Hello, DumbEditor!",
      range: { start: 0.3, end: 1.3 },
      position: "center",
      fontSize: 24,
      color: "#ffffff",
    }, "add title");
    assert.equal(text.version.action, "Added text at 00:00.3–00:01.3");
    const textInside = await brightPixelCount(text.version.filePath, 0.8);
    const textOutside = await brightPixelCount(text.version.filePath, 0.1);
    assert.ok(textInside > textOutside + 20, `expected more bright text pixels (${textInside} vs ${textOutside})`);

    await store.revert("v0000");
    const captioned = await executeAdvancedEdit(store, { action: "subtitles", filePath: subtitles }, "burn captions");
    assert.ok(await changedPixelCount(captioned.version.filePath, 0.1, 0.8) > 20);

    await store.revert("v0000");
    const overlaid = await executeAdvancedEdit(store, {
      action: "image-overlay",
      filePath: image,
      range: { start: 0.4, end: 1.4 },
      x: 8,
      y: 6,
      width: 24,
      height: 18,
      opacity: 0.5,
    }, "add logo");
    const beforeOverlay = await pixel(overlaid.version.filePath, 0.1, 12, 10);
    const duringOverlay = await pixel(overlaid.version.filePath, 0.8, 12, 10);
    assert.ok(beforeOverlay[2] > beforeOverlay[0] * 2);
    assert.ok(duringOverlay[0] > beforeOverlay[0] + 50);
    assert.ok(duringOverlay[2] > 40);

    await store.revert("v0000");
    const effected = await executeAdvancedEdit(store, {
      action: "effect",
      effect: "grayscale",
      range: { start: 0.4, end: 1.4 },
    }, "make middle grayscale");
    const beforeEffect = await pixel(effected.version.filePath, 0.1, 80, 45);
    const duringEffect = await pixel(effected.version.filePath, 0.8, 80, 45);
    assert.ok(beforeEffect[2] > beforeEffect[0] * 2);
    assert.ok(Math.max(...duringEffect) - Math.min(...duringEffect) < 8);

    await store.revert("v0000");
    const faded = await executeAdvancedEdit(store, {
      action: "fade",
      direction: "in",
      range: { start: 0, end: 0.6 },
      audio: true,
    }, "fade in");
    const fadeStart = await pixel(faded.version.filePath, 0.03, 80, 45);
    const fadeEnd = await pixel(faded.version.filePath, 0.9, 80, 45);
    assert.ok(fadeStart.reduce((total, channel) => total + channel, 0) < 60);
    assert.ok(fadeEnd.reduce((total, channel) => total + channel, 0) > 200);

    await store.revert("v0000");
    const mixed = await executeAdvancedEdit(store, {
      action: "background-music",
      filePath: music,
      volume: 0.2,
      loop: true,
      trim: { start: 0.1, end: 0.3 },
      startAt: 0.3,
    }, "add quiet looping music");
    assert.equal(mixed.media.hasAudio, true);
    assert.ok(mixed.media.duration > 2.3 && mixed.media.duration < 2.5);
    assert.ok(await audioPeak(mixed.version.filePath, 0.05, 0.15) < 100);
    const latePeak = await audioPeak(mixed.version.filePath, 1.8, 0.2);
    assert.ok(latePeak > 300 && latePeak < 1_500, `unexpected mixed peak ${latePeak}`);

    assert.equal(store.snapshot.versions.length, 7);
    for (const version of store.snapshot.versions.slice(1)) {
      assert.equal((await probeMedia(version.filePath)).width, 160);
      assert.equal((await probeMedia(version.filePath)).height, 90);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects invalid local inputs and preserves FFmpeg failure details", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-advanced-errors-"));
  try {
    const source = join(directory, "source.mp4");
    await runProcess("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=160x90:rate=20:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ], { timeoutMs: 30_000 });
    const store = await ProjectStore.open(source);

    await assert.rejects(
      executeAdvancedEdit(store, { action: "subtitles", filePath: join(directory, "missing.srt") }, "missing captions"),
      /Advanced edit failed: Subtitle file was not found/,
    );
    await assert.rejects(
      executeAdvancedEdit(store, { action: "effect", effect: "blur", range: { start: 0.5, end: 2 } }, "bad time"),
      /Advanced edit failed: Visual effect must stay inside the media duration/,
    );

    const brokenImage = join(directory, "broken.png");
    await writeFile(brokenImage, "not an image", "utf8");
    await assert.rejects(
      executeAdvancedEdit(store, {
        action: "image-overlay",
        filePath: brokenImage,
        range: { start: 0, end: 0.5 },
      }, "broken image"),
      /Advanced edit failed: Overlay image has no readable image stream/,
    );

    const validImage = join(directory, "deleted-before-render.ppm");
    const header = Buffer.from("P6\n2 2\n255\n", "ascii");
    await writeFile(validImage, Buffer.concat([header, Buffer.alloc(12, 255)]));
    await assert.rejects(
      executeAdvancedEdit(store, {
        action: "image-overlay",
        filePath: validImage,
        range: { start: 0, end: 0.5 },
      }, "deleted image", (stage) => {
        if (stage === "Rendering with FFmpeg") unlinkSync(validImage);
      }),
      /Advanced edit failed: ffmpeg exited with code/,
    );
    assert.equal(store.snapshot.versions.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lets the agent compose a custom FFmpeg graph while confining file inputs", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-custom-render-"));
  try {
    const source = join(directory, "source.mp4");
    await runProcess("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=160x90:rate=20:duration=1",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100:d=1",
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source,
    ], { timeoutMs: 30_000 });
    const store = await ProjectStore.open(source);
    const workspace = new AgentWorkspace(store.createAgentWorkspace());
    await workspace.initialize();
    const rendered = await executeCustomRender({
      store, workspace, filterGraph: "[0:v]negate[vout]", assetIds: [], videoMap: "[vout]", audioMap: "0:a:0?",
      summary: "Applied Luna's custom negative", request: "make it a negative",
    });
    assert.equal(rendered.version.id, "v0001");
    assert.equal(rendered.media.hasAudio, true);
    const changed = await pixel(rendered.version.filePath, 0.5, 80, 45);
    assert.ok(changed[0] > 200 && changed[1] > 200 && changed[2] < 30);
    await assert.rejects(executeCustomRender({
      store, workspace, filterGraph: "movie=C\\:/private/file.png[vout]", assetIds: [], videoMap: "[vout]", audioMap: null,
      summary: "Unsafe input", request: "read another file",
    }), /may only read the active video and declared workspace assets/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createFixtures(paths: { source: string; music: string; image: string; subtitles: string }): Promise<void> {
  await runProcess("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=0x2040c0:size=160x90:rate=20:duration=2.4",
    "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100:d=2.4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", paths.source,
  ], { timeoutMs: 30_000 });
  await runProcess("ffmpeg", [
    "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.5",
    "-af", "apad=pad_dur=0.5", "-t", "1", "-c:a", "pcm_s16le", paths.music,
  ], { timeoutMs: 30_000 });

  const header = Buffer.from("P6\n24 18\n255\n", "ascii");
  const pixels = Buffer.alloc(24 * 18 * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) pixels[offset] = 255;
  await writeFile(paths.image, Buffer.concat([header, pixels]));
  await writeFile(paths.subtitles, "1\n00:00:00,300 --> 00:00:01,300\nSubtitle test\n\n", "utf8");
}

async function rawFrame(filePath: string, at: number): Promise<Buffer> {
  const result = await runProcess("ffmpeg", [
    "-v", "error", "-ss", String(at), "-i", filePath,
    "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ], { timeoutMs: 20_000, maxOutputBytes: 160 * 90 * 3 + 1024 });
  return result.stdout;
}

async function pixel(filePath: string, at: number, x: number, y: number): Promise<[number, number, number]> {
  const frame = await rawFrame(filePath, at);
  const offset = (y * 160 + x) * 3;
  return [frame[offset] ?? 0, frame[offset + 1] ?? 0, frame[offset + 2] ?? 0];
}

async function brightPixelCount(filePath: string, at: number): Promise<number> {
  const frame = await rawFrame(filePath, at);
  let count = 0;
  for (let offset = 0; offset + 2 < frame.length; offset += 3) {
    if ((frame[offset] ?? 0) + (frame[offset + 1] ?? 0) + (frame[offset + 2] ?? 0) > 650) count += 1;
  }
  return count;
}

async function changedPixelCount(filePath: string, firstTime: number, secondTime: number): Promise<number> {
  const first = await rawFrame(filePath, firstTime);
  const second = await rawFrame(filePath, secondTime);
  let count = 0;
  for (let offset = 0; offset + 2 < first.length && offset + 2 < second.length; offset += 3) {
    const difference = Math.abs((first[offset] ?? 0) - (second[offset] ?? 0))
      + Math.abs((first[offset + 1] ?? 0) - (second[offset + 1] ?? 0))
      + Math.abs((first[offset + 2] ?? 0) - (second[offset + 2] ?? 0));
    if (difference > 30) count += 1;
  }
  return count;
}

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
