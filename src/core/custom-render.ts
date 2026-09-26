import { rm } from "node:fs/promises";
import type { AgentWorkspace } from "./agent-workspace.js";
import { probeMedia } from "./media.js";
import { runProcess } from "./process.js";
import type { ProjectStore } from "./project.js";

export interface CustomRenderOptions {
  store: ProjectStore;
  workspace: AgentWorkspace;
  filterGraph: string;
  assetIds: string[];
  videoMap: string;
  audioMap: string | null;
  summary: string;
  request: string;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

/** A flexible FFmpeg compositor whose readable inputs are limited to the active video and workspace assets. */
export async function executeCustomRender(options: CustomRenderOptions) {
  const graph = safeFilterGraph(options.filterGraph);
  const summary = options.summary.trim();
  if (!summary || summary.length > 160) throw new Error("Custom render summary must be 1 to 160 characters.");
  if (options.assetIds.length > 12) throw new Error("A custom render can use at most 12 workspace assets.");
  const videoMap = safeMap(options.videoMap, "video_map");
  const audioMap = options.audioMap === null ? null : safeMap(options.audioMap, "audio_map");
  const assets = await Promise.all(options.assetIds.map((id) => options.workspace.asset(id)));
  const output = options.store.nextOutputPath(".mp4");
  const args = ["-y", "-v", "error", "-i", options.store.current.filePath];
  for (const asset of assets) args.push("-i", asset.path);
  args.push("-filter_complex", graph, "-map", videoMap);
  if (audioMap) args.push("-map", audioMap, "-c:a", "aac", "-b:a", "192k");
  else args.push("-an");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", output);

  let committed = false;
  try {
    options.onStage?.("Rendering Luna's custom FFmpeg composition");
    await runProcess("ffmpeg", args, {
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 8_000_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    options.onStage?.("Checking custom render");
    const media = await probeMedia(output);
    const version = await options.store.commit({ outputPath: output, action: summary, request: options.request, duration: media.duration, agent: true });
    committed = true;
    return { version, media };
  } finally {
    if (!committed) await rm(output, { force: true }).catch(() => undefined);
  }
}

function safeFilterGraph(value: string): string {
  const graph = value.trim();
  if (!graph || graph.length > 20_000 || /[\0\r\n]/.test(graph)) throw new Error("filter_graph must be one line with 1 to 20,000 characters.");
  // Inputs must be passed as workspace asset IDs. These filters can otherwise open arbitrary local or network resources.
  if (/(^|[,;])\s*(?:a?movie|zmq|azmq)\s*=|(?:textfile|fontfile|filename)\s*=/i.test(graph)) {
    throw new Error("The filter graph may only read the active video and declared workspace assets.");
  }
  return graph;
}

function safeMap(value: string, name: string): string {
  const map = value.trim();
  if (!/^(?:\[[A-Za-z0-9_.:+-]+\]|\d+:[av](?::\d+)?\??)$/.test(map)) {
    throw new Error(`${name} must be a filter label such as [vout] or a stream such as 0:a:0?.`);
  }
  return map;
}
