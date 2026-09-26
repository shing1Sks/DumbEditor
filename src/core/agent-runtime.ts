import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DirectEdit, MediaInfo, Selection } from "../types.js";
import { executeAdvancedEdit, type AdvancedEdit, type TextPosition, type VisualEffect } from "./advanced-editor.js";
import { AgentWorkspace } from "./agent-workspace.js";
import type { RequestApproval } from "./approval.js";
import { generateAsset } from "./asset-generation.js";
import { runClaudeHarness } from "./claude-harness.js";
import { executeCustomRender } from "./custom-render.js";
import { executeDirectEdit } from "./editor.js";
import { runLunaAgent, type AgentTool, type LunaAgentResult } from "./luna-agent.js";
import { findMusicTrack, searchMusicTracks } from "./music-catalog.js";
import { selectedMusicTrack } from "./music.js";
import { extractRawFrame, probeMedia } from "./media.js";
import { runProcess } from "./process.js";
import { ProjectStore } from "./project.js";
import { localSandboxStatus, runSandboxScript } from "./sandbox.js";
import { transcribeVideoToSrt } from "./transcription.js";
import { readSettings, type AgentPermissionMode, type DumbEditorSettings } from "./settings.js";

export interface EditorAgentResult extends LunaAgentResult {
  media: MediaInfo;
  versionId: string;
}

export async function runEditorAgent(options: {
  request: string;
  store: ProjectStore;
  media: MediaInfo;
  currentTime: number;
  selection: Selection;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onCost?: (kind: "luna" | "asset" | "harness", costUsd: number) => void;
  requestApproval?: RequestApproval;
}): Promise<EditorAgentResult> {
  const workspace = new AgentWorkspace(options.store.createAgentWorkspace());
  await workspace.initialize();
  const history = await options.store.chatHistory();
  const settings = await readSettings();
  const last = history.at(-1);
  if (last?.role === "user" && last.content === options.request) history.pop();
  const tools = createEditorAgentTools({ ...options, workspace, permissionMode: settings.agent.permissionMode,
    claudeModel: settings.agent.claudeModel, claudeMaxBudgetUsd: settings.agent.claudeMaxBudgetUsd, models: settings.models });
  const result = await runLunaAgent({
    request: options.request,
    media: options.media,
    currentVersionId: options.store.current.id,
    currentTime: options.currentTime,
    selection: options.selection,
    history,
    tools,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onStage ? { onStage: options.onStage } : {}),
    onLedger: (direction, items) => options.store.appendAgentContext(direction, items),
    onUsage: async (usage) => {
      await options.store.appendUsage({
        kind: "luna",
        provider: "openai",
        model: "gpt-6-luna",
        label: options.request.slice(0, 160),
        costUsd: usage.costUsd,
        estimated: false,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        outputTokens: usage.outputTokens,
      });
      options.onCost?.("luna", usage.costUsd);
    },
  });
  return {
    ...result,
    media: await probeMedia(options.store.current.filePath),
    versionId: options.store.current.id,
  };
}

function createEditorAgentTools(context: {
  request: string;
  store: ProjectStore;
  workspace: AgentWorkspace;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
  onCost?: (kind: "luna" | "asset" | "harness", costUsd: number) => void;
  requestApproval?: RequestApproval;
  permissionMode: AgentPermissionMode;
  claudeModel: string;
  claudeMaxBudgetUsd: number;
  models: DumbEditorSettings["models"];
}): AgentTool[] {
  const direct = (name: string, description: string, parameters: Record<string, unknown>, make: (args: Record<string, unknown>) => DirectEdit): AgentTool => ({
    name, description, parameters, mutatesProject: true,
    run: async (args) => editResult(await executeDirectEdit(context.store, make(args), context.request, context.onStage)),
  });
  const advanced = (name: string, description: string, parameters: Record<string, unknown>, make: (args: Record<string, unknown>) => Promise<AdvancedEdit> | AdvancedEdit): AgentTool => ({
    name, description, parameters, mutatesProject: true,
    run: async (args) => editResult(await executeAdvancedEdit(context.store, await make(args), context.request, context.onStage)),
  });

  return [
    direct("remove_ranges", "Remove one or more time ranges from the active video.", objectSchema({
      ranges: { type: "array", minItems: 1, maxItems: 20, items: rangeSchema() },
    }), (args) => ({ action: "remove", ranges: ranges(args.ranges) })),
    direct("keep_range", "Keep only one time range and discard everything outside it.", objectSchema({
      start: numberSchema(0), end: numberSchema(0),
    }), (args) => ({ action: "trim", range: range(args) })),
    direct("change_speed", "Change playback speed inside one time range.", objectSchema({
      start: numberSchema(0), end: numberSchema(0), factor: { type: "number", minimum: 0.25, maximum: 16 },
    }), (args) => ({ action: "speed", range: range(args), factor: number(args.factor, "factor") })),
    direct("mute_range", "Mute the source audio inside one time range.", objectSchema({
      start: numberSchema(0), end: numberSchema(0),
    }), (args) => ({ action: "mute", range: range(args) })),
    direct("crop_video", "Crop the whole video. Use null x/y to center the crop.", objectSchema({
      width: { type: "integer", minimum: 2 }, height: { type: "integer", minimum: 2 },
      x: nullableInteger(0), y: nullableInteger(0),
    }), (args) => ({ action: "crop", width: integer(args.width, "width"), height: integer(args.height, "height"),
      ...(args.x === null ? {} : { x: integer(args.x, "x") }), ...(args.y === null ? {} : { y: integer(args.y, "y") }) })),
    advanced("add_text_overlay", "Add styled text over a time range.", objectSchema({
      text: stringSchema(1, 20_000), start: numberSchema(0), end: numberSchema(0),
      position: { type: "string", enum: ["top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right"] },
      font_size: { type: "integer", minimum: 6, maximum: 500 }, color: stringSchema(1, 32),
    }), (args) => ({ action: "text", text: string(args.text, "text"), range: range(args), position: args.position as TextPosition,
      fontSize: integer(args.font_size, "font_size"), color: string(args.color, "color") })),
    advanced("burn_subtitles", "Burn an SRT, VTT, ASS, or SSA file from the agent workspace into the video.", objectSchema({
      workspace_path: stringSchema(1, 240),
    }), async (args) => ({ action: "subtitles", filePath: await workspacePath(context.workspace, string(args.workspace_path, "workspace_path")) })),
    {
      name: "transcribe_and_add_subtitles",
      description: "Automatically transcribe the active video's speech, create a timed SRT, and burn the subtitles into a new video version. Use this whenever the user asks to add, generate, or create subtitles and has not supplied a subtitle file.",
      parameters: objectSchema({
        language: { type: ["string", "null"], maxLength: 40 },
        context: { type: ["string", "null"], maxLength: 1000 },
        model: { type: ["string", "null"], maxLength: 200 },
        provider_options_json: { type: ["string", "null"], maxLength: 10_000 },
      }),
      mutatesProject: true,
      run: async (args) => {
        const overrides = await transcriptionOverrides(context, args);
        const transcription = await transcribeVideoToSrt({
          filePath: context.store.current.filePath,
          workspace: context.workspace,
          ...(typeof args.language === "string" ? { language: args.language } : {}),
          ...(typeof args.context === "string" ? { context: args.context } : {}),
          ...overrides,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onStage ? { onStage: context.onStage } : {}),
        });
        const subtitleAsset = await registerTranscription(context, transcription);
        const edited = await executeAdvancedEdit(
          context.store,
          { action: "subtitles", filePath: transcription.path },
          context.request,
          context.onStage,
        );
        return {
          ok: true,
          message: `${edited.version.id}: ${edited.version.action}`,
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
      parameters: objectSchema({
        language: { type: ["string", "null"], maxLength: 40 },
        context: { type: ["string", "null"], maxLength: 1000 },
        model: { type: ["string", "null"], maxLength: 200 },
        provider_options_json: { type: ["string", "null"], maxLength: 10_000 },
      }),
      run: async (args) => {
        const overrides = await transcriptionOverrides(context, args);
        const result = await transcribeVideoToSrt({
          filePath: context.store.current.filePath,
          workspace: context.workspace,
          ...(typeof args.language === "string" ? { language: args.language } : {}),
          ...(typeof args.context === "string" ? { context: args.context } : {}),
          ...overrides,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onStage ? { onStage: context.onStage } : {}),
        });
        const asset = await registerTranscription(context, result);
        return { ok: true, message: `Transcribed ${result.cueCount} subtitle cues.`, data: { ...result, assetId: asset.id } as unknown as Record<string, unknown> };
      },
    },
    advanced("add_image_overlay", "Overlay a generated image asset over a time range.", objectSchema({
      asset_id: stringSchema(1, 100), start: numberSchema(0), end: numberSchema(0),
      x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
      width: nullableInteger(1), height: nullableInteger(1), opacity: { type: "number", minimum: 0, maximum: 1 },
    }), async (args) => {
      const asset = await context.workspace.asset(string(args.asset_id, "asset_id"));
      if (asset.kind !== "image") throw new Error("The selected asset is not an image.");
      return { action: "image-overlay", filePath: asset.path, range: range(args), x: integer(args.x, "x"), y: integer(args.y, "y"),
        ...(args.width === null ? {} : { width: integer(args.width, "width") }),
        ...(args.height === null ? {} : { height: integer(args.height, "height") }), opacity: number(args.opacity, "opacity") };
    }),
    advanced("apply_visual_effect", "Apply grayscale, sepia, blur, sharpen, or vignette over a time range.", objectSchema({
      effect: { type: "string", enum: ["grayscale", "sepia", "blur", "sharpen", "vignette"] },
      start: numberSchema(0), end: numberSchema(0), intensity: { type: "number", minimum: 0, maximum: 1 },
    }), (args) => ({ action: "effect", effect: args.effect as VisualEffect, range: range(args), intensity: number(args.intensity, "intensity") })),
    advanced("add_fade", "Add a video fade and optional matching audio fade.", objectSchema({
      direction: { type: "string", enum: ["in", "out"] }, start: numberSchema(0), end: numberSchema(0),
      color: stringSchema(1, 32), audio: { type: "boolean" },
    }), (args) => ({ action: "fade", direction: args.direction as "in" | "out", range: range(args), color: string(args.color, "color"), audio: Boolean(args.audio) })),
    advanced("add_background_music", "Mix a selected catalog track or generated music/audio asset under the video.", objectSchema({
      source: { type: "string", enum: ["selected", "catalog", "asset"] }, reference: { type: ["string", "null"], maxLength: 100 },
      volume: { type: "number", minimum: 0, maximum: 2 }, loop: { type: "boolean" }, start_at: numberSchema(0),
    }), async (args) => ({ action: "background-music", filePath: await musicPath(context.workspace, string(args.source, "source"), args.reference),
      volume: number(args.volume, "volume"), loop: Boolean(args.loop), startAt: number(args.start_at, "start_at") })),
    {
      name: "generate_asset", description: "Generate an image, speech audio, music clip, or video asset. Normally use the configured default. You may request another provider/model and endpoint parameters when the task needs them; ask mode pauses for user approval before that switch.",
      parameters: objectSchema({ kind: { type: "string", enum: ["image", "audio", "music", "video"] }, prompt: stringSchema(1, 8000),
        duration: { type: ["number", "null"], minimum: 1, maximum: 15 }, voice: { type: ["string", "null"], maxLength: 80 },
        provider: { type: ["string", "null"], enum: ["openai", "openrouter", null] },
        model: { type: ["string", "null"], maxLength: 200 },
        provider_options_json: { type: ["string", "null"], maxLength: 10_000 },
      }),
      run: async (args) => {
        const kind = args.kind as "image" | "audio" | "music" | "video";
        const provider = args.provider === "openai" || args.provider === "openrouter" ? args.provider : undefined;
        const model = typeof args.model === "string" ? args.model : undefined;
        const providerOptions = typeof args.provider_options_json === "string" ? jsonObject(args.provider_options_json, "provider_options_json") : undefined;
        const defaults = defaultAssetRoute(kind, context.models);
        const switchesDefault = Boolean(model && model !== defaults.model) || Boolean(provider && provider !== defaults.provider) || Boolean(providerOptions);
        if (switchesDefault) {
          const approved = context.permissionMode === "auto" || await context.requestApproval?.({
            category: "model-switch",
            title: `Use a custom ${kind} model for this request`,
            description: "Luna wants to override the configured provider, model, or generation parameters for this one asset.",
            provider: provider ?? defaults.provider,
            model: model ?? defaults.model,
            ...(providerOptions ? { parameters: providerOptions } : {}),
          }) === true;
          if (!approved) return { ok: false, message: "The user denied the model or parameter override." };
        }
        const asset = await generateAsset(args.kind as "image" | "audio" | "music" | "video", {
          prompt: string(args.prompt, "prompt"), workspace: context.workspace,
          ...(typeof args.duration === "number" ? { duration: args.duration } : {}),
          ...(typeof args.voice === "string" ? { voice: args.voice } : {}),
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(providerOptions ? { providerOptions } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onStage ? { onStage: context.onStage } : {}),
        });
        await recordAssetUsage(context.store, asset);
        if (asset.costUsd !== undefined) context.onCost?.("asset", asset.costUsd);
        return { ok: true, message: `Created ${asset.id}`, data: asset as unknown as Record<string, unknown> };
      },
    },
    {
      name: "delegate_to_claude_harness",
      description: "Delegate an unusually complex workspace task to the optional Claude coding-agent harness. Use this for multi-file scripts, unusual media pipelines, or diagnosis that benefits from a coding agent. The harness works only in the project workspace and returns its files and summary.",
      parameters: objectSchema({
        task: stringSchema(1, 8_000),
        model: { type: ["string", "null"], maxLength: 200 },
        max_budget_usd: { type: ["number", "null"], minimum: 0.01, maximum: 20 },
        max_turns: { type: "integer", minimum: 1, maximum: 50 },
        effort: { type: "string", enum: ["low", "medium", "high"] },
      }),
      run: async (args) => {
        const model = typeof args.model === "string" ? args.model : context.claudeModel;
        const maxBudgetUsd = typeof args.max_budget_usd === "number" ? args.max_budget_usd : context.claudeMaxBudgetUsd;
        const approved = context.permissionMode === "auto" || await context.requestApproval?.({
          category: "coding-harness",
          title: "Delegate work to the Claude coding harness",
          description: `Claude will work inside this project's agent workspace with a maximum budget of $${maxBudgetUsd.toFixed(2)}. Tool actions that need permission will be shown separately.`,
          provider: "Anthropic Claude Agent SDK",
          model,
          parameters: { maxBudgetUsd, maxTurns: args.max_turns, effort: args.effort },
        }) === true;
        if (!approved) return { ok: false, message: "The user denied the Claude harness delegation." };
        const result = await runClaudeHarness({
          task: string(args.task, "task"),
          model,
          maxBudgetUsd,
          maxTurns: integer(args.max_turns, "max_turns"),
          effort: args.effort as "low" | "medium" | "high",
          permissionMode: context.permissionMode,
          workspace: context.workspace,
          activeVideoPath: context.store.current.filePath,
          ...(context.requestApproval ? { requestApproval: context.requestApproval } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onStage ? { onStage: context.onStage } : {}),
        });
        await context.store.appendUsage({
          kind: "harness", provider: "anthropic", model: result.model,
          label: string(args.task, "task").slice(0, 160), costUsd: result.costUsd, estimated: true,
        });
        context.onCost?.("harness", result.costUsd);
        return { ok: true, message: result.result, data: { model: result.model, costUsd: result.costUsd,
          sessionId: result.sessionId, files: result.files } };
      },
    },
    {
      name: "render_custom_ffmpeg",
      description: "Build a custom FFmpeg filter graph when no specialized edit tool fits. Input 0 is the active video; inputs 1 onward are asset_ids in the given order. Produce a labeled video output such as [vout], and optionally an audio output such as [aout] or map 0:a:0?. This is the general composition layer for overlays, animation, transitions, color work, audio processing, and combinations of effects.",
      parameters: objectSchema({
        filter_graph: stringSchema(1, 20_000),
        asset_ids: { type: "array", maxItems: 12, items: stringSchema(1, 100) },
        video_map: stringSchema(1, 100),
        audio_map: { type: ["string", "null"], maxLength: 100 },
        summary: stringSchema(1, 160),
      }),
      mutatesProject: true,
      run: async (args) => {
        if (!Array.isArray(args.asset_ids) || !args.asset_ids.every((id) => typeof id === "string")) throw new Error("asset_ids must be an array of asset IDs.");
        const result = await executeCustomRender({
          store: context.store,
          workspace: context.workspace,
          filterGraph: string(args.filter_graph, "filter_graph"),
          assetIds: args.asset_ids,
          videoMap: string(args.video_map, "video_map"),
          audioMap: args.audio_map === null ? null : string(args.audio_map, "audio_map"),
          summary: string(args.summary, "summary"),
          request: context.request,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.onStage ? { onStage: context.onStage } : {}),
        });
        return editResult(result);
      },
    },
    {
      name: "inspect_video_frames", description: "Extract up to eight frames and show them to the model for visual inspection.",
      auditsProject: true,
      parameters: objectSchema({ timestamps: { type: "array", minItems: 1, maxItems: 8, items: numberSchema(0) }, detail: { type: "string", enum: ["low", "high"] } }),
      run: async (args) => inspectFrames(context.store.current.filePath, args.timestamps, args.detail, context.workspace),
    },
    {
      name: "search_music_catalog", description: "Search the built-in CC BY music catalog and return license and attribution details.",
      parameters: objectSchema({ query: stringSchema(0, 200) }),
      run: async (args) => ({ ok: true, message: "Music catalog results", data: { tracks: searchMusicTracks(string(args.query, "query")).map(trackData) } }),
    },
    {
      name: "list_assets", description: "List assets already available in this project's agent workspace.", parameters: objectSchema({}),
      run: async () => ({ ok: true, message: "Workspace assets", data: { assets: await context.workspace.assets() } }),
    },
    {
      name: "write_workspace_file", description: "Write a text file such as SRT subtitles, ASS captions, JSON, or a reusable script into the isolated project workspace. This does not execute scripts.",
      parameters: objectSchema({ path: stringSchema(1, 240), content: stringSchema(0, 1_000_000) }),
      run: async (args) => ({ ok: true, message: "Workspace file written", data: { path: await context.workspace.writeText(string(args.path, "path"), string(args.content, "content")) } }),
    },
    {
      name: "run_sandbox_script", description: "Run a Python or JavaScript file written to the project workspace through DumbEditor's local OS sandbox. Call sandbox_status first. The active video path is passed as the script's first argument; only the project workspace is writable; network and host API keys are unavailable.",
      parameters: objectSchema({
        language: { type: "string", enum: ["python", "javascript"] },
        workspace_path: stringSchema(1, 240),
        arguments: { type: "array", maxItems: 30, items: stringSchema(0, 500) },
      }),
      run: async (args) => {
        if (!Array.isArray(args.arguments) || !args.arguments.every((item) => typeof item === "string")) throw new Error("arguments must be an array of strings.");
        context.onStage?.("SANDBOX · running isolated script");
        const result = await runSandboxScript({
          language: args.language as "python" | "javascript",
          workspace: context.workspace,
          workspacePath: string(args.workspace_path, "workspace_path"),
          activeVideoPath: context.store.current.filePath,
          arguments: args.arguments,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        return { ok: true, message: "Sandbox script completed.", data: result };
      },
    },
    {
      name: "register_workspace_asset", description: "Register an image, video, audio, music, or other file created by a sandbox script so other editing tools can use it by asset ID.",
      parameters: objectSchema({
        kind: { type: "string", enum: ["image", "video", "audio", "music", "file"] },
        workspace_path: stringSchema(1, 240),
        description: stringSchema(1, 500),
      }),
      run: async (args) => {
        const asset = await context.workspace.registerWorkspaceFile(
          args.kind as "image" | "video" | "audio" | "music" | "file",
          string(args.workspace_path, "workspace_path"),
          string(args.description, "description"),
        );
        return { ok: true, message: `Registered ${asset.id}.`, data: asset as unknown as Record<string, unknown> };
      },
    },
    {
      name: "read_workspace_file", description: "Read a text file from the isolated project workspace.", parameters: objectSchema({ path: stringSchema(1, 240) }),
      run: async (args) => ({ ok: true, message: "Workspace file contents", data: { content: await context.workspace.readText(string(args.path, "path")) } }),
    },
    {
      name: "list_workspace_files", description: "List text files in the isolated project workspace.", parameters: objectSchema({}),
      run: async () => ({ ok: true, message: "Workspace files", data: { files: await context.workspace.listFiles() } }),
    },
    {
      name: "search_project_chat", description: "Search the complete local project transcript for older requests or decisions.",
      parameters: objectSchema({ query: stringSchema(1, 500), limit: { type: "integer", minimum: 1, maximum: 50 } }),
      run: async (args) => ({ ok: true, message: "Chat search results", data: { messages: await context.store.searchChat(string(args.query, "query"), integer(args.limit, "limit")) } }),
    },
    {
      name: "sandbox_status", description: "Report the project workspace boundary and whether arbitrary script execution is safely available.", parameters: objectSchema({}),
      run: async () => {
        const sandbox = await localSandboxStatus();
        return { ok: true, message: sandbox.available
          ? `Custom FFmpeg and isolated script execution are available through ${sandbox.detail}.`
          : `Custom FFmpeg is available. Isolated scripts are disabled: ${sandbox.detail}.`,
        data: { root: context.workspace.root, scriptExecution: sandbox.available, sandbox: sandbox.detail, customFfmpeg: true, builtInFfmpegTools: true } };
      },
    },
  ];
}

async function inspectFrames(filePath: string, value: unknown, detail: unknown, workspace: AgentWorkspace) {
  if (!Array.isArray(value)) throw new Error("timestamps must be an array");
  const timestamps = value.map((item) => number(item, "timestamp"));
  const width = detail === "high" ? 1280 : 640;
  const items: Array<Record<string, unknown>> = [];
  for (const timestamp of timestamps) {
    const sampleSize = { width: 32, height: 18 };
    const sample = await extractRawFrame(filePath, timestamp, sampleSize);
    const average = averageRgb(sample);
    const path = workspace.assetPath("image", ".jpg");
    await runProcess("ffmpeg", ["-y", "-v", "error", "-ss", timestamp.toFixed(3), "-i", filePath, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "3", path],
      { timeoutMs: 30_000, maxOutputBytes: 1_000_000 });
    const bytes = await readFile(path);
    items.push({ role: "user", content: [
      { type: "input_text", text: `Frame at ${timestamp.toFixed(3)} seconds. Whole-frame average RGB: ${average.red}, ${average.green}, ${average.blue}. Use this numeric measurement as a cross-check, while relying on the image for objects, layout, and local colors.` },
      { type: "input_image", image_url: `data:image/jpeg;base64,${bytes.toString("base64")}`, detail },
    ] });
  }
  return { ok: true, message: `Extracted ${items.length} frame(s).`, data: { timestamps }, inputItems: items };
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

async function musicPath(workspace: AgentWorkspace, source: string, reference: unknown): Promise<string> {
  if (source === "asset") {
    if (typeof reference !== "string") throw new Error("An asset reference is required.");
    const asset = await workspace.asset(reference);
    if (asset.kind !== "music" && asset.kind !== "audio") throw new Error("The selected asset is not audio or music.");
    return asset.path;
  }
  const track = source === "selected" ? await selectedMusicTrack() : typeof reference === "string" ? findMusicTrack(reference) : null;
  if (!track) throw new Error(source === "selected" ? "No background track is selected. Use /bg-music first." : "Catalog track was not found.");
  const path = workspace.assetPath("music", ".mp3");
  const response = await fetch(track.assetUrl);
  if (!response.ok) throw new Error(`Could not download ${track.title}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 100_000_000) throw new Error("Catalog music download was empty or too large.");
  await writeFile(path, bytes);
  await workspace.registerAsset({ kind: "music", path, source: "catalog", description: track.title,
    license: track.license.attribution, sourceUrl: track.sourceUrl, costUsd: 0, costEstimated: false });
  return path;
}

async function registerTranscription(
  context: { store: ProjectStore; workspace: AgentWorkspace; onCost?: (kind: "luna" | "asset", costUsd: number) => void },
  transcription: Awaited<ReturnType<typeof transcribeVideoToSrt>>,
) {
  const asset = await context.workspace.registerAsset({
    kind: "file",
    path: transcription.path,
    source: "generated",
    description: `Subtitles (${transcription.cueCount} cues)`,
    model: transcription.model,
    costUsd: transcription.costUsd,
    costEstimated: transcription.costEstimated,
  });
  await recordAssetUsage(context.store, asset);
  context.onCost?.("asset", transcription.costUsd);
  return asset;
}

async function recordAssetUsage(store: ProjectStore, asset: Awaited<ReturnType<AgentWorkspace["registerAsset"]>>): Promise<void> {
  if (asset.costUsd === undefined) return;
  await store.appendUsage({
    kind: "asset",
    provider: asset.source === "catalog" || asset.source === "agent" ? "local" : asset.model?.includes("/") ? "openrouter" : "openai",
    model: asset.model ?? asset.source,
    label: asset.description.slice(0, 160),
    costUsd: asset.costUsd,
    estimated: asset.costEstimated ?? false,
    assetId: asset.id,
  });
}

async function workspacePath(workspace: AgentWorkspace, requested: string): Promise<string> {
  await workspace.readText(requested);
  return join(workspace.filesDirectory, ...requested.split("/"));
}

function editResult(result: { version: { id: string; action: string }; media: MediaInfo }) {
  return { ok: true, message: `${result.version.id}: ${result.version.action}`, data: { versionId: result.version.id, action: result.version.action, media: result.media } };
}

function trackData(track: NonNullable<ReturnType<typeof findMusicTrack>>) {
  return { id: track.id, title: track.title, artist: track.artist, description: track.description, genres: track.genres, moods: track.moods,
    durationSeconds: track.durationSeconds, license: track.license, sourceUrl: track.sourceUrl };
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
function rangeSchema() { return objectSchema({ start: numberSchema(0), end: numberSchema(0) }); }
function numberSchema(minimum: number) { return { type: "number", minimum }; }
function nullableInteger(minimum: number) { return { type: ["integer", "null"], minimum }; }
function stringSchema(minLength: number, maxLength: number) { return { type: "string", minLength, maxLength }; }
function range(args: Record<string, unknown>) { return { start: number(args.start, "start"), end: number(args.end, "end") }; }
function ranges(value: unknown) {
  if (!Array.isArray(value)) throw new Error("ranges must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each range must be an object");
    return range(item as Record<string, unknown>);
  });
}
function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}
function integer(value: unknown, label: string): number {
  const result = number(value, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be a whole number`);
  return result;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value;
}

function jsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${label} must contain valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must contain a JSON object.`);
  return parsed as Record<string, unknown>;
}

function defaultAssetRoute(kind: "image" | "audio" | "music" | "video", models: DumbEditorSettings["models"]): { provider: "openai" | "openrouter"; model: string } {
  if (kind === "audio") return { provider: "openai", model: models.openai.speech };
  if (kind === "image" && !process.env.OPENROUTER_API_KEY?.trim()) return { provider: "openai", model: "gpt-image-1-mini" };
  return { provider: "openrouter", model: models.openrouter[kind] };
}

async function transcriptionOverrides(
  context: { models: DumbEditorSettings["models"]; permissionMode: AgentPermissionMode; requestApproval?: RequestApproval },
  args: Record<string, unknown>,
): Promise<{ model?: string; providerOptions?: Record<string, unknown> }> {
  const model = typeof args.model === "string" ? args.model : undefined;
  const providerOptions = typeof args.provider_options_json === "string" ? jsonObject(args.provider_options_json, "provider_options_json") : undefined;
  if (!model && !providerOptions) return {};
  const selected = model ?? context.models.openai.transcription;
  const approved = context.permissionMode === "auto" || await context.requestApproval?.({
    category: "model-switch",
    title: "Use a custom transcription model for this request",
    description: selected.includes("diarize")
      ? "Luna requested speaker diarization. DumbEditor will preserve speaker labels and segment timing in the subtitle asset."
      : "Luna wants to override the configured transcription model or endpoint parameters for this request.",
    provider: "openai",
    model: selected,
    ...(providerOptions ? { parameters: providerOptions } : {}),
  }) === true;
  if (!approved) throw new Error("The user denied the transcription model or parameter override.");
  return { ...(model ? { model } : {}), ...(providerOptions ? { providerOptions } : {}) };
}
