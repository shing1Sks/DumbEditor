import { readFile } from "node:fs/promises";
import { AssetGenerationError, generateAsset } from "../asset-generation.js";
import type { AgentAsset } from "../agent-workspace.js";
import { executeAdvancedEdit } from "../advanced-editor.js";
import { extractRawFrame } from "../media.js";
import { searchMusicTracks, type MusicTrack } from "../music-catalog.js";
import { runProcess } from "../process.js";
import { transcribeVideoToSrt, type TranscriptionResult } from "../transcription.js";
import { number, numberSchema, objectSchema, optionalJsonObject, optionalOverride, string, stringSchema } from "./schema.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

const transcriptionSchema = () => objectSchema({
  language: { type: ["string", "null"], maxLength: 40 },
  context: { type: ["string", "null"], maxLength: 1000 },
  model: { type: ["string", "null"], maxLength: 200 },
  provider_options_json: { type: ["string", "null"], maxLength: 10_000 },
});

export function createMediaActions(): Action<any>[] {
  const overridesModel = (args: Args) => Boolean(optionalOverride(args.model) || optionalOverride(args.provider_options_json));
  return [
    {
      name: "transcribe_and_add_subtitles",
      description: "Automatically transcribe the active video's speech, create a timed SRT, and burn the subtitles into a new video version. Use this whenever the user asks to add, generate, or create subtitles and has not supplied a subtitle file.",
      schema: transcriptionSchema(),
      risk: (args: Args) => overridesModel(args) ? "spend" : "edit",
      describe: () => "Transcribe speech and burn subtitles",
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const transcription = await transcribe(ctx, args);
        const subtitleAsset = await registerTranscription(ctx, transcription);
        const edited = await executeAdvancedEdit(
          ctx.state.store, { action: "subtitles", filePath: transcription.path }, ctx.request,
          (stage) => ctx.progress({ stage }), ctx.signal,
        );
        return {
          text: `${edited.version.id}: ${edited.version.action}`,
          versionId: edited.version.id,
          data: {
            versionId: edited.version.id,
            subtitlePath: transcription.path,
            cueCount: transcription.cueCount,
            model: transcription.model,
            assetId: subtitleAsset.id,
            costUsd: transcription.costUsd,
            ...(transcription.language ? { language: transcription.language } : {}),
          },
        };
      },
    },
    {
      name: "transcribe_video_audio",
      description: "Transcribe the active video's speech into a transcript and timed SRT without changing the video. Use this to understand, summarize, or inspect spoken content.",
      schema: transcriptionSchema(),
      risk: (args: Args) => overridesModel(args) ? "spend" : "read",
      describe: () => "Transcribe speech",
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const result = await transcribe(ctx, args);
        const asset = await registerTranscription(ctx, result);
        return { text: `Transcribed ${result.cueCount} subtitle cues.`, data: { ...result, assetId: asset.id } as unknown as Record<string, unknown> };
      },
    },
    {
      name: "generate_asset",
      description: "Generate an image, speech audio, music clip, or video asset. Normally use the configured default. You may request another provider/model and endpoint parameters when the task needs them. Generation costs money, so the user may be asked to approve it.",
      schema: objectSchema({
        kind: { type: "string", enum: ["image", "audio", "music", "video"] }, prompt: stringSchema(1, 8000),
        duration: { type: ["number", "null"], minimum: 1, maximum: 15 }, voice: { type: ["string", "null"], maxLength: 80 },
        provider: { type: ["string", "null"], enum: ["openai", "openrouter", null] },
        model: { type: ["string", "null"], maxLength: 200 },
        provider_options_json: { type: ["string", "null"], maxLength: 10_000 },
      }),
      risk: "spend",
      describe: (args: Args) => `Generate ${String(args.kind)}: ${String(args.prompt).slice(0, 60)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const kind = args.kind as "image" | "audio" | "music" | "video";
        const provider = args.provider === "openai" || args.provider === "openrouter" ? args.provider : undefined;
        const model = optionalOverride(args.model);
        const voice = optionalOverride(args.voice);
        const providerOptions = optionalJsonObject(args.provider_options_json, "provider_options_json");
        const prompt = string(args.prompt, "prompt");
        let asset: AgentAsset;
        try {
          asset = await generateAsset(kind, {
            prompt, workspace: ctx.state.workspace, signal: ctx.signal,
            ...(typeof args.duration === "number" ? { duration: args.duration } : {}),
            ...(voice ? { voice } : {}),
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
            ...(providerOptions ? { providerOptions } : {}),
            onStage: (stage) => ctx.progress({ stage }),
          });
        } catch (error) {
          if (error instanceof AssetGenerationError && error.costUsd !== undefined) {
            await ctx.state.recordUsage({
              kind: "asset", provider: error.provider, model: error.model,
              label: `Failed ${kind}: ${prompt}`.slice(0, 160), costUsd: error.costUsd, estimated: false,
            });
          }
          throw error;
        }
        await recordAssetUsage(ctx, asset);
        await ctx.state.refreshAssets();
        return { text: `Created ${asset.id}`, data: asset as unknown as Record<string, unknown> };
      },
    },
    {
      name: "inspect_video_frames",
      description: "Extract up to eight frames from the active version and show them to the model for visual inspection.",
      schema: objectSchema({ timestamps: { type: "array", minItems: 1, maxItems: 8, items: numberSchema(0) }, detail: { type: "string", enum: ["low", "high"] } }),
      risk: "read",
      audits: true,
      describe: (args: Args) => `Inspect ${Array.isArray(args.timestamps) ? args.timestamps.length : 0} frame(s)`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        if (!Array.isArray(args.timestamps)) throw new Error("timestamps must be an array");
        const timestamps = args.timestamps.map((item) => number(item, "timestamp"));
        return extractFrames(ctx, ctx.state.store.current.filePath, timestamps, args.detail === "high" ? 1280 : 640);
      },
    },
    {
      name: "search_music_catalog",
      description: "Search the built-in CC BY music catalog and return license and attribution details.",
      schema: objectSchema({ query: stringSchema(0, 200) }),
      risk: "read",
      describe: (args: Args) => `Search music: ${String(args.query)}`,
      run: async (args: Args): Promise<ActionResult> => ({
        text: "Music catalog results",
        data: { tracks: searchMusicTracks(string(args.query, "query")).map(trackData) },
      }),
    },
    {
      name: "list_assets",
      description: "List assets already available in this project's agent workspace.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "List workspace assets",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Workspace assets", data: { assets: await ctx.state.workspace.assets() },
      }),
    },
    {
      name: "register_workspace_asset",
      description: "Register an image, video, audio, music, or other file created by a sandbox script so other editing tools can use it by asset ID.",
      schema: objectSchema({
        kind: { type: "string", enum: ["image", "video", "audio", "music", "file"] },
        workspace_path: stringSchema(1, 240),
        description: stringSchema(1, 500),
      }),
      risk: "edit",
      describe: (args: Args) => `Register ${String(args.workspace_path)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const asset = await ctx.state.workspace.registerWorkspaceFile(
          args.kind as "image" | "video" | "audio" | "music" | "file",
          string(args.workspace_path, "workspace_path"),
          string(args.description, "description"),
        );
        await ctx.state.refreshAssets();
        return { text: `Registered ${asset.id}.`, data: asset as unknown as Record<string, unknown> };
      },
    },
  ];
}

/** Extract frames from one video file as JPEGs for the model, with a numeric colour cross-check per frame. */
export async function extractFrames(ctx: ActionContext, filePath: string, timestamps: number[], width: number, label = ""): Promise<ActionResult> {
  const lines: string[] = [];
  const images: NonNullable<ActionResult["images"]> = [];
  for (const timestamp of timestamps) {
    const sample = await extractRawFrame(filePath, timestamp, { width: 32, height: 18 }, ctx.signal);
    const average = averageRgb(sample);
    const path = ctx.state.workspace.assetPath("image", ".jpg");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-ss", timestamp.toFixed(3), "-i", filePath, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", path],
      { timeoutMs: 30_000, maxOutputBytes: 1_000_000, signal: ctx.signal });
    images.push({ mimeType: "image/jpeg", data: (await readFile(path)).toString("base64") });
    lines.push(`Image ${images.length}: ${label}frame at ${timestamp.toFixed(3)} seconds. Whole-frame average RGB: ${average.red}, ${average.green}, ${average.blue}. Use this numeric measurement as a cross-check, while relying on the image for objects, layout, and local colors.`);
  }
  return { text: `Extracted ${images.length} frame(s). Images follow in this order.\n${lines.join("\n")}`, images, data: { timestamps } };
}

function averageRgb(buffer: Buffer): { red: number; green: number; blue: number } {
  if (buffer.length < 3) return { red: 0, green: 0, blue: 0 };
  let red = 0;
  let green = 0;
  let blue = 0;
  let pixels = 0;
  for (let offset = 0; offset + 2 < buffer.length; offset += 3) {
    red += buffer[offset] ?? 0;
    green += buffer[offset + 1] ?? 0;
    blue += buffer[offset + 2] ?? 0;
    pixels += 1;
  }
  return { red: Math.round(red / pixels), green: Math.round(green / pixels), blue: Math.round(blue / pixels) };
}

async function transcribe(ctx: ActionContext, args: Args): Promise<TranscriptionResult> {
  const model = optionalOverride(args.model);
  const providerOptions = optionalJsonObject(args.provider_options_json, "provider_options_json");
  return transcribeVideoToSrt({
    filePath: ctx.state.store.current.filePath,
    workspace: ctx.state.workspace,
    signal: ctx.signal,
    onStage: (stage) => ctx.progress({ stage }),
    ...(typeof args.language === "string" ? { language: args.language } : {}),
    ...(typeof args.context === "string" ? { context: args.context } : {}),
    ...(model ? { model } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  });
}

async function registerTranscription(ctx: ActionContext, transcription: TranscriptionResult): Promise<AgentAsset> {
  const asset = await ctx.state.workspace.registerAsset({
    kind: "file",
    path: transcription.path,
    source: "generated",
    description: `Subtitles (${transcription.cueCount} cues)`,
    model: transcription.model,
    costUsd: transcription.costUsd,
    costEstimated: transcription.costEstimated,
  });
  await recordAssetUsage(ctx, asset);
  await ctx.state.refreshAssets();
  return asset;
}

async function recordAssetUsage(ctx: ActionContext, asset: AgentAsset): Promise<void> {
  if (asset.costUsd === undefined) return;
  await ctx.state.recordUsage({
    kind: "asset",
    provider: asset.source === "catalog" || asset.source === "agent" ? "local" : asset.model?.includes("/") ? "openrouter" : "openai",
    model: asset.model ?? asset.source,
    label: asset.description.slice(0, 160),
    costUsd: asset.costUsd,
    estimated: asset.costEstimated ?? false,
    assetId: asset.id,
  });
}

function trackData(track: MusicTrack) {
  return {
    id: track.id, title: track.title, artist: track.artist, description: track.description, genres: track.genres, moods: track.moods,
    durationSeconds: track.durationSeconds, license: track.license, sourceUrl: track.sourceUrl,
  };
}
