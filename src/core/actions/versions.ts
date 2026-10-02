import { readFile, rm, writeFile } from "node:fs/promises";
import { runProcess } from "../process.js";
import { numberSchema, objectSchema, number, string, stringSchema } from "./schema.js";
import { extractFrames } from "./media.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

export function createVersionActions(): Action<any>[] {
  return [
    {
      name: "get_editor_state",
      description: "Return the current playhead, in/out marks, active version, video details and recent versions. Call this when the user refers to \"here\", \"this part\", or the current selection.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "Read editor state",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => ({ text: ctx.state.describe().body }),
    },
    {
      name: "list_versions",
      description: "List the retained versions of this project as a tree: id, parent, what the version did, and which one is active.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "List versions",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const { versions, currentVersionId } = ctx.state.store.snapshot;
        const rows = versions.map((version) => ({
          id: version.id, parentId: version.parentId, action: version.action, duration: version.duration,
          active: version.id === currentVersionId, createdAt: version.createdAt,
        }));
        return { text: `${rows.length} retained version(s); active is ${currentVersionId}.`, data: { versions: rows } };
      },
    },
    {
      name: "revert_to",
      description: "Make an earlier retained version the active one. A later edit then branches from it, so nothing is lost. Accepts \"3\", \"v3\" or \"v0003\".",
      schema: objectSchema({ version: stringSchema(1, 20) }),
      risk: "edit",
      describe: (args: Args) => `Revert to ${String(args.version)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const version = await ctx.state.revertTo(string(args.version, "version"));
        return { text: `Now on ${version.id}: ${version.action}`, versionId: version.id, data: { versionId: version.id, action: version.action } };
      },
    },
    {
      name: "compare_frames",
      description: "Show frames from two retained versions side by side (version A on the left, B on the right) at the same timestamps, to check what an edit changed.",
      schema: objectSchema({
        version_a: stringSchema(1, 20), version_b: stringSchema(1, 20),
        timestamps: { type: "array", minItems: 1, maxItems: 4, items: numberSchema(0) },
      }),
      risk: "read",
      describe: (args: Args) => `Compare ${String(args.version_a)} and ${String(args.version_b)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        if (!Array.isArray(args.timestamps)) throw new Error("timestamps must be an array");
        const store = ctx.state.store;
        const a = store.resolveVersion(string(args.version_a, "version_a"));
        const b = store.resolveVersion(string(args.version_b, "version_b"));
        const timestamps = args.timestamps.map((item) => number(item, "timestamp"));
        const left = await extractFrames(ctx, a.filePath, timestamps, 640, `${a.id} `);
        const right = await extractFrames(ctx, b.filePath, timestamps, 640, `${b.id} `);
        const images: NonNullable<ActionResult["images"]> = [];
        for (let index = 0; index < timestamps.length; index += 1) {
          const pair = await sideBySide(ctx, left.images?.[index]?.data, right.images?.[index]?.data);
          images.push({ mimeType: "image/jpeg", data: pair });
        }
        const lines = timestamps.map((timestamp, index) => `Image ${index + 1}: ${a.id} (left) vs ${b.id} (right) at ${timestamp.toFixed(3)} seconds.`);
        return { text: `Compared ${timestamps.length} timestamp(s). Images follow in this order.\n${lines.join("\n")}`, images };
      },
    },
  ];
}

async function sideBySide(ctx: ActionContext, left: string | undefined, right: string | undefined): Promise<string> {
  if (!left || !right) throw new Error("Could not extract a frame to compare.");
  const leftPath = ctx.state.workspace.assetPath("image", ".jpg");
  const rightPath = ctx.state.workspace.assetPath("image", ".jpg");
  const outputPath = ctx.state.workspace.assetPath("image", ".jpg");
  try {
    await writeFile(leftPath, Buffer.from(left, "base64"));
    await writeFile(rightPath, Buffer.from(right, "base64"));
    await runProcess("ffmpeg", ["-y", "-v", "error", "-i", leftPath, "-i", rightPath, "-filter_complex", "[0:v]scale=-2:360[l];[1:v]scale=-2:360[r];[l][r]hstack=inputs=2", "-frames:v", "1", "-q:v", "3", outputPath],
      { timeoutMs: 30_000, maxOutputBytes: 1_000_000, signal: ctx.signal });
    return (await readFile(outputPath)).toString("base64");
  } finally {
    await Promise.all([leftPath, rightPath, outputPath].map((path) => rm(path, { force: true }).catch(() => undefined)));
  }
}
