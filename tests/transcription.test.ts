import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentWorkspace } from "../src/core/agent-workspace.js";
import { AssetGenerationError, generateAsset } from "../src/core/asset-generation.js";
import { runProcess } from "../src/core/process.js";
import { transcribeVideoToSrt } from "../src/core/transcription.js";

test("transcribes video audio into a timed SRT inside the agent workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-transcription-"));
  const video = join(directory, "speech-source.mp4");
  const workspace = new AgentWorkspace(join(directory, "agent"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let request: RequestInit | undefined;
  try {
    await runProcess("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-shortest", "-c:v", "libx264", "-c:a", "aac", video,
    ], { timeoutMs: 30_000 });
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return Response.json({ text: "DumbEditor creates subtitles automatically. This is the second caption.", language: "en" });
    }) as typeof fetch;

    const result = await transcribeVideoToSrt({ filePath: video, workspace });
    const srt = await readFile(result.path, "utf8");
    assert.equal(result.model, "gpt-transcribe");
    assert.equal(result.language, "en");
    assert.equal(result.costEstimated, true);
    assert.ok(result.costUsd > 0);
    assert.ok(result.cueCount >= 2);
    assert.match(srt, /00:00:00,000 -->/);
    assert.match(srt, /DumbEditor creates subtitles\s+automatically\./);
    assert.ok(request?.body instanceof FormData);
    assert.equal(request.body.get("model"), "gpt-transcribe");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates speech through the configured direct OpenAI TTS model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-speech-"));
  const workspace = new AgentWorkspace(join(directory, "agent"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  try {
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    }) as typeof fetch;
    const asset = await generateAsset("audio", { prompt: "Hello from DumbEditor", workspace });
    assert.equal(requestedUrl, "https://api.openai.com/v1/audio/speech");
    assert.equal(requestedBody.model, "gpt-4o-mini-tts");
    assert.equal(requestedBody.voice, "marin");
    assert.equal(asset.kind, "audio");
    assert.equal(asset.model, "gpt-4o-mini-tts");
    assert.equal(asset.costEstimated, true);
    assert.ok((asset.costUsd ?? 0) > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates music from nested audio data while keeping transport options nonstreaming", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-music-generation-"));
  const workspace = new AgentWorkspace(join(directory, "agent"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  let requestedBody: Record<string, unknown> = {};
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        choices: [{ message: { content: [{ type: "audio", audio_url: { url: "data:audio/wav;base64,AQID" } }] } }],
        usage: { cost: 0.04 },
      });
    }) as typeof fetch;
    const asset = await generateAsset("music", {
      prompt: "A calm electronic loop without vocals",
      workspace,
      model: "default",
      providerOptions: { stream: true, stream_options: { include_usage: true }, temperature: 0.8 },
    });
    assert.notEqual(requestedBody.model, "default");
    assert.equal(requestedBody.stream, undefined);
    assert.equal(requestedBody.stream_options, undefined);
    assert.equal(requestedBody.temperature, 0.8);
    assert.deepEqual(await readFile(asset.path), Buffer.from([1, 2, 3]));
    assert.equal(asset.kind, "music");
    assert.equal(asset.source, "generated");
    assert.equal(asset.costUsd, 0.04);
    assert.match(asset.path, /\.wav$/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves provider cost when music generation returns an empty result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-empty-music-"));
  const workspace = new AgentWorkspace(join(directory, "agent"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = "test-key";
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: [] } }], usage: { cost: 0.04 } })) as typeof fetch;
    await assert.rejects(
      generateAsset("music", { prompt: "A short ambient loop", workspace, model: "google/lyria-test" }),
      (error: unknown) => error instanceof AssetGenerationError
        && error.model === "google/lyria-test"
        && error.costUsd === 0.04
        && /empty result/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves speaker labels and timings from a diarization model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-diarization-"));
  const video = join(directory, "meeting.mp4");
  const workspace = new AgentWorkspace(join(directory, "agent"));
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  let request: RequestInit | undefined;
  try {
    await runProcess("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=3",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-c:v", "libx264", "-c:a", "aac", video,
    ], { timeoutMs: 30_000 });
    process.env.OPENAI_API_KEY = "test-key";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return Response.json({
        text: "Hello. Welcome.",
        segments: [
          { speaker: "A", start: 0.1, end: 1.2, text: "Hello." },
          { speaker: "B", start: 1.3, end: 2.8, text: "Welcome." },
        ],
        usage: { input_tokens: 1000, output_tokens: 100 },
      });
    }) as typeof fetch;
    const result = await transcribeVideoToSrt({ filePath: video, workspace, model: "gpt-4o-transcribe-diarize" });
    const srt = await readFile(result.path, "utf8");
    assert.match(srt, /A: Hello\./);
    assert.match(srt, /B: Welcome\./);
    assert.match(srt, /00:00:00,100 --> 00:00:01,200/);
    assert.equal(result.costUsd, 0.0035);
    assert.ok(request?.body instanceof FormData);
    assert.equal(request.body.get("response_format"), "diarized_json");
    assert.equal(request.body.get("chunking_strategy"), "auto");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    await rm(directory, { recursive: true, force: true });
  }
});
