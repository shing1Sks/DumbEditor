import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DirectEdit, MediaInfo } from "../../types.js";
import { executeAdvancedEdit, type AdvancedEdit, type TextPosition, type VisualEffect } from "../advanced-editor.js";
import type { AgentWorkspace } from "../agent-workspace.js";
import { executeCustomRender } from "../custom-render.js";
import { executeDirectEdit } from "../editor.js";
import { findMusicTrack } from "../music-catalog.js";
import { selectedMusicTrack } from "../music.js";
import { formatTime } from "../time.js";
import { integer, nullableInteger, number, numberSchema, objectSchema, range, rangeSchema, ranges, string, stringSchema } from "./schema.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

function editResult(result: { version: { id: string; action: string }; media: MediaInfo }): ActionResult {
  return {
    text: `${result.version.id}: ${result.version.action}`,
    data: { versionId: result.version.id, action: result.version.action, media: result.media },
    versionId: result.version.id,
  };
}

function direct(
  name: string,
  description: string,
  schema: Record<string, unknown>,
  make: (args: Args) => DirectEdit,
  describe: (args: Args) => string,
): Action<Args> {
  return {
    name, description, schema, risk: "edit", describe,
    run: async (args, ctx) => editResult(await executeDirectEdit(
      ctx.state.store, make(args), ctx.request, (stage) => ctx.progress({ stage }), ctx.signal,
    )),
  };
}

function advanced(
  name: string,
  description: string,
  schema: Record<string, unknown>,
  make: (args: Args, ctx: ActionContext) => Promise<AdvancedEdit> | AdvancedEdit,
  describe: (args: Args) => string,
): Action<Args> {
  return {
    name, description, schema, risk: "edit", describe,
    run: async (args, ctx) => editResult(await executeAdvancedEdit(
      ctx.state.store, await make(args, ctx), ctx.request, (stage) => ctx.progress({ stage }), ctx.signal,
    )),
  };
}

const span = (args: Args) => `${formatTime(number(args.start, "start"))}–${formatTime(number(args.end, "end"))}`;

/** Map a parsed slash command to the action that performs it, so commands and the agent share one path. */
export function directEditCall(edit: DirectEdit): { name: string; args: Args } {
  if (edit.action === "remove") return { name: "remove_ranges", args: { ranges: edit.ranges } };
  if (edit.action === "trim") return { name: "keep_range", args: { start: edit.range.start, end: edit.range.end } };
  if (edit.action === "speed") return { name: "change_speed", args: { start: edit.range.start, end: edit.range.end, factor: edit.factor } };
  if (edit.action === "mute") return { name: "mute_range", args: { start: edit.range.start, end: edit.range.end } };
  return { name: "crop_video", args: { width: edit.width, height: edit.height, x: edit.x ?? null, y: edit.y ?? null } };
}

export function createEditActions(): Action<any>[] {
  return [
    direct("remove_ranges", "Remove one or more time ranges from the active video.", objectSchema({
      ranges: { type: "array", minItems: 1, maxItems: 20, items: rangeSchema() },
    }), (args) => ({ action: "remove", ranges: ranges(args.ranges) }),
    (args) => `Remove ${ranges(args.ranges).map((item) => `${formatTime(item.start)}–${formatTime(item.end)}`).join(", ")}`),

    direct("keep_range", "Keep only one time range and discard everything outside it.", objectSchema({
      start: numberSchema(0), end: numberSchema(0),
    }), (args) => ({ action: "trim", range: range(args) }), (args) => `Keep ${span(args)}`),

    direct("change_speed", "Change playback speed inside one time range.", objectSchema({
      start: numberSchema(0), end: numberSchema(0), factor: { type: "number", minimum: 0.25, maximum: 16 },
    }), (args) => ({ action: "speed", range: range(args), factor: number(args.factor, "factor") }),
    (args) => `Speed ${span(args)} to ${String(args.factor)}x`),

    direct("mute_range", "Mute the source audio inside one time range.", objectSchema({
      start: numberSchema(0), end: numberSchema(0),
    }), (args) => ({ action: "mute", range: range(args) }), (args) => `Mute ${span(args)}`),

    direct("crop_video", "Crop the whole video. Use null x/y to center the crop.", objectSchema({
      width: { type: "integer", minimum: 2 }, height: { type: "integer", minimum: 2 },
      x: nullableInteger(0), y: nullableInteger(0),
    }), (args) => ({
      action: "crop", width: integer(args.width, "width"), height: integer(args.height, "height"),
      ...(args.x === null ? {} : { x: integer(args.x, "x") }), ...(args.y === null ? {} : { y: integer(args.y, "y") }),
    }), (args) => `Crop to ${String(args.width)}x${String(args.height)}`),

    advanced("add_text_overlay", "Add styled text over a time range.", objectSchema({
      text: stringSchema(1, 20_000), start: numberSchema(0), end: numberSchema(0),
      position: { type: "string", enum: ["top-left", "top-center", "top-right", "center", "bottom-left", "bottom-center", "bottom-right"] },
      font_size: { type: "integer", minimum: 6, maximum: 500 }, color: stringSchema(1, 32),
    }), (args) => ({
      action: "text", text: string(args.text, "text"), range: range(args), position: args.position as TextPosition,
      fontSize: integer(args.font_size, "font_size"), color: string(args.color, "color"),
    }), (args) => `Text “${String(args.text).slice(0, 40)}” ${span(args)}`),

    advanced("burn_subtitles", "Burn an SRT, VTT, ASS, or SSA file from the agent workspace into the video.", objectSchema({
      workspace_path: stringSchema(1, 240),
    }), async (args, ctx) => ({ action: "subtitles", filePath: await workspacePath(ctx.state.workspace, string(args.workspace_path, "workspace_path")) }),
    (args) => `Burn subtitles from ${String(args.workspace_path)}`),

    advanced("add_image_overlay", "Overlay a generated image asset over a time range.", objectSchema({
      asset_id: stringSchema(1, 100), start: numberSchema(0), end: numberSchema(0),
      x: { type: "integer", minimum: 0 }, y: { type: "integer", minimum: 0 },
      width: nullableInteger(1), height: nullableInteger(1), opacity: { type: "number", minimum: 0, maximum: 1 },
    }), async (args, ctx) => {
      const asset = await ctx.state.workspace.asset(string(args.asset_id, "asset_id"));
      if (asset.kind !== "image") throw new Error("The selected asset is not an image.");
      return {
        action: "image-overlay", filePath: asset.path, range: range(args), x: integer(args.x, "x"), y: integer(args.y, "y"),
        ...(args.width === null ? {} : { width: integer(args.width, "width") }),
        ...(args.height === null ? {} : { height: integer(args.height, "height") }), opacity: number(args.opacity, "opacity"),
      };
    }, (args) => `Image ${String(args.asset_id)} ${span(args)}`),

    advanced("apply_visual_effect", "Apply grayscale, sepia, blur, sharpen, or vignette over a time range.", objectSchema({
      effect: { type: "string", enum: ["grayscale", "sepia", "blur", "sharpen", "vignette"] },
      start: numberSchema(0), end: numberSchema(0), intensity: { type: "number", minimum: 0, maximum: 1 },
    }), (args) => ({
      action: "effect", effect: args.effect as VisualEffect, range: range(args), intensity: number(args.intensity, "intensity"),
    }), (args) => `${String(args.effect)} ${span(args)}`),

    advanced("add_fade", "Add a video fade and optional matching audio fade.", objectSchema({
      direction: { type: "string", enum: ["in", "out"] }, start: numberSchema(0), end: numberSchema(0),
      color: stringSchema(1, 32), audio: { type: "boolean" },
    }), (args) => ({
      action: "fade", direction: args.direction as "in" | "out", range: range(args), color: string(args.color, "color"), audio: Boolean(args.audio),
    }), (args) => `Fade ${String(args.direction)} ${span(args)}`),

    advanced("add_background_music", "Mix a selected catalog track or generated music/audio asset under the video.", objectSchema({
      source: { type: "string", enum: ["selected", "catalog", "asset"] }, reference: { type: ["string", "null"], maxLength: 100 },
      volume: { type: "number", minimum: 0, maximum: 2 }, loop: { type: "boolean" }, start_at: numberSchema(0),
    }), async (args, ctx) => ({
      action: "background-music", filePath: await musicPath(ctx.state.workspace, string(args.source, "source"), args.reference),
      volume: number(args.volume, "volume"), loop: Boolean(args.loop), startAt: number(args.start_at, "start_at"),
    }), (args) => `Background music (${String(args.source)})`),

    {
      name: "render_custom_ffmpeg",
      description: "Build a custom FFmpeg filter graph when no specialized edit tool fits. Input 0 is the active video; inputs 1 onward are asset_ids in the given order. Produce a labeled video output such as [vout], and optionally an audio output such as [aout] or map 0:a:0?. This is the general composition layer for overlays, animation, transitions, color work, audio processing, and combinations of effects.",
      schema: objectSchema({
        filter_graph: stringSchema(1, 20_000),
        asset_ids: { type: "array", maxItems: 12, items: stringSchema(1, 100) },
        video_map: stringSchema(1, 100),
        audio_map: { type: ["string", "null"], maxLength: 100 },
        summary: stringSchema(1, 160),
      }),
      risk: "code",
      describe: (args: Args) => `Custom FFmpeg: ${String(args.summary)}`,
      run: async (args: Args, ctx: ActionContext) => {
        if (!Array.isArray(args.asset_ids) || !args.asset_ids.every((id) => typeof id === "string")) throw new Error("asset_ids must be an array of asset IDs.");
        return editResult(await executeCustomRender({
          store: ctx.state.store,
          workspace: ctx.state.workspace,
          filterGraph: string(args.filter_graph, "filter_graph"),
          assetIds: args.asset_ids,
          videoMap: string(args.video_map, "video_map"),
          audioMap: args.audio_map === null ? null : string(args.audio_map, "audio_map"),
          summary: string(args.summary, "summary"),
          request: ctx.request,
          signal: ctx.signal,
          onStage: (stage) => ctx.progress({ stage }),
        }));
      },
    },
  ];
}

async function workspacePath(workspace: AgentWorkspace, requested: string): Promise<string> {
  await workspace.readText(requested);
  return join(workspace.filesDirectory, ...requested.split("/"));
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
  await workspace.registerAsset({
    kind: "music", path, source: "catalog", description: track.title,
    license: `${track.license.attribution} License: ${track.license.url} Modified: mixed into the edited video's soundtrack.`,
    sourceUrl: track.sourceUrl, costUsd: 0, costEstimated: false,
  });
  return path;
}
