import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeAdvancedEdit, MAX_IMAGE_CUES } from "../src/core/advanced-editor.js";
import { AgentWorkspace } from "../src/core/agent-workspace.js";
import { executeCustomRender } from "../src/core/custom-render.js";
import { probeMedia } from "../src/core/media.js";
import { runProcess } from "../src/core/process.js";
import { ProjectStore } from "../src/core/project.js";
import { overrideCanvasLoader } from "../src/core/text-image.js";

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

    // Text and captions go through libass when this FFmpeg has it and are drawn as images when it does not (macOS CI).
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

async function withImageRenderer<T>(body: () => Promise<T>): Promise<T> {
  const saved = process.env.DUMBEDITOR_TEXT_RENDERER;
  process.env.DUMBEDITOR_TEXT_RENDERER = "images";
  try { return await body(); } finally {
    if (saved === undefined) delete process.env.DUMBEDITOR_TEXT_RENDERER; else process.env.DUMBEDITOR_TEXT_RENDERER = saved;
  }
}

test("text and captions drawn as images appear inside their time range only", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-images-"));
  try {
    const source = join(directory, "source.mp4");
    const subtitles = join(directory, "captions.srt");
    await createFixtures({ source, music: join(directory, "music.wav"), image: join(directory, "overlay.ppm"), subtitles });
    const store = await ProjectStore.open(source);
    await store.setVersionLimit(10);
    await withImageRenderer(async () => {
      const text = await executeAdvancedEdit(store, {
        action: "text", text: "Hello, DumbEditor!", range: { start: 0.3, end: 1.3 }, position: "center", fontSize: 24, color: "#ffffff",
      }, "add title");
      assert.equal(text.version.action, "Added text at 00:00.3–00:01.3");
      const inside = await brightPixelCount(text.version.filePath, 0.8);
      const before = await brightPixelCount(text.version.filePath, 0.1);
      const after = await brightPixelCount(text.version.filePath, 2.0);
      assert.ok(inside > before + 20, `text appears inside the range (${inside} vs ${before})`);
      assert.ok(after <= before + 5, `and is gone after it (${after} vs ${before})`);

      await store.revert("v0000");
      const captioned = await executeAdvancedEdit(store, { action: "subtitles", filePath: subtitles }, "burn captions");
      assert.equal(captioned.version.action, "Burned in subtitles");
      assert.ok(await changedPixelCount(captioned.version.filePath, 0.1, 0.8) > 20, "the cue shows up");
      assert.ok(await changedPixelCount(captioned.version.filePath, 0.1, 2.0) < 5, "and is gone after its time");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("text on a rotated phone clip is placed on the upright frame, not the stored one", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-rotated-"));
  try {
    const base = join(directory, "base.mp4");
    await createFixtures({ source: base, music: join(directory, "m.wav"), image: join(directory, "o.ppm"), subtitles: join(directory, "c.srt") });
    const rotated = join(directory, "rotated.mp4");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-display_rotation", "90", "-i", base, "-c", "copy", rotated], { timeoutMs: 30_000 });
    const store = await ProjectStore.open(rotated);
    await withImageRenderer(async () => {
      const result = await executeAdvancedEdit(store, {
        action: "text", text: "Hello there", range: { start: 0.2, end: 1.5 }, position: "bottom-center", fontSize: 14, color: "#ffffff",
      }, "add title");
      const media = await probeMedia(result.version.filePath);
      assert.deepEqual([media.width, media.height], [90, 160], "the render is upright");
      const frame = await rawFrame(result.version.filePath, 0.8);
      const half = (90 * 160 * 3) / 2;
      let top = 0;
      let bottom = 0;
      for (let offset = 0; offset + 2 < frame.length; offset += 3) {
        if ((frame[offset] ?? 0) + (frame[offset + 1] ?? 0) + (frame[offset + 2] ?? 0) > 650) { if (offset < half) top += 1; else bottom += 1; }
      }
      assert.ok(bottom > 20, `text in the lower half (${bottom})`);
      assert.ok(top < 5, `and none in the upper half (${top})`);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("overlapping captions are stacked, not printed on top of each other", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-overlap-"));
  try {
    const source = join(directory, "source.mp4");
    const subtitles = join(directory, "overlap.srt");
    await createFixtures({ source, music: join(directory, "m.wav"), image: join(directory, "o.ppm"), subtitles: join(directory, "c.srt") });
    await writeFile(subtitles, "1\n00:00:00,200 --> 00:00:01,200\nAAAA AAAA\n\n2\n00:00:00,500 --> 00:00:01,500\nBBBB BBBB\n\n", "utf8");
    const store = await ProjectStore.open(source);
    await withImageRenderer(async () => {
      const result = await executeAdvancedEdit(store, { action: "subtitles", filePath: subtitles }, "captions");
      const onlyFirst = await brightPixelCount(result.version.filePath, 0.35);
      const both = await brightPixelCount(result.version.filePath, 0.8);
      const onlySecond = await brightPixelCount(result.version.filePath, 1.4);
      assert.ok(onlyFirst > 10 && onlySecond > 10, `each cue shows alone (${onlyFirst}, ${onlySecond})`);
      assert.ok(both > Math.max(onlyFirst, onlySecond) * 1.5, `both show at once, side by side in height (${both} vs ${onlyFirst}, ${onlySecond})`);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("without libass an .ass file, an empty caption file and too many cues are refused before anything is saved", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-images-errors-"));
  try {
    const source = join(directory, "source.mp4");
    await createFixtures({ source, music: join(directory, "m.wav"), image: join(directory, "o.ppm"), subtitles: join(directory, "c.srt") });
    const store = await ProjectStore.open(source);
    await withImageRenderer(async () => {
      const ass = join(directory, "styled.ass");
      await writeFile(ass, "[Script Info]\n", "utf8");
      await assert.rejects(executeAdvancedEdit(store, { action: "subtitles", filePath: ass }, "x"), /libass[\s\S]*dumbeditor doctor/);
      const empty = join(directory, "empty.srt");
      await writeFile(empty, "nothing here", "utf8");
      await assert.rejects(executeAdvancedEdit(store, { action: "subtitles", filePath: empty }, "x"), /no readable cues/);
      const srtTime = (seconds: number) => {
        const ms = Math.round(seconds * 1000);
        return `00:00:${String(Math.floor(ms / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
      };
      let body = "";
      for (let index = 0; index < MAX_IMAGE_CUES + 1; index += 1) body += `${index + 1}\n${srtTime(index * 0.01)} --> ${srtTime(2.2)}\ncue ${index}\n\n`;
      const many = join(directory, "many.srt");
      await writeFile(many, body, "utf8");
      await assert.rejects(executeAdvancedEdit(store, { action: "subtitles", filePath: many }, "x"), /limit[\s\S]*dumbeditor doctor/);
      const huge = join(directory, "huge.srt");
      await writeFile(huge, "1\n00:00:01,000 --> 00:00:02,000\n" + "x".repeat(2_100_000) + "\n", "utf8");
      await assert.rejects(executeAdvancedEdit(store, { action: "subtitles", filePath: huge }, "x"), /too large[\s\S]*dumbeditor doctor/);
      overrideCanvasLoader(async () => null);
      try {
        await assert.rejects(
          executeAdvancedEdit(store, { action: "text", text: "Hi", range: { start: 0.2, end: 1 }, position: "center" }, "x"),
          /Advanced edit failed:[\s\S]*dumbeditor doctor/,
        );
      } finally { overrideCanvasLoader(null); }
    });
    assert.equal(store.snapshot.versions.length, 1, "nothing was committed");
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
