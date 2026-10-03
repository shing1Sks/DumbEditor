import { loadCapabilities, type FfmpegCapabilities } from "../core/ffmpeg-capabilities.js";
import { detectPreviewBackend } from "../core/media.js";
import { runProcess } from "../core/process.js";
import { localSandboxStatus } from "../core/sandbox.js";
import { loadCanvas } from "../core/text-image.js";
import { explainBackend, type PainterId } from "../shell/preview/painters/index.js";
import { installHints } from "./hints.js";

/** Filters the editor's own commands use. Every FFmpeg build has them. */
export const REQUIRED_FILTERS = [
  "scale", "fps", "crop", "overlay", "volume", "colorchannelmixer", "hue", "boxblur", "vignette", "unsharp", "fade",
  "trim", "atrim", "setpts", "asetpts", "concat", "amix", "afade", "adelay", "atempo", "hstack", "format",
] as const;
export const REQUIRED_ENCODERS = ["libx264", "aac"] as const;
const MINIMUM_NODE = [22, 19] as const;

export interface DoctorInputs {
  node: string;
  platform: NodeJS.Platform;
  ffmpeg: FfmpegCapabilities | null;
  ffprobe: boolean;
  ffplay: boolean;
  imageLibrary: boolean;
  painter: { id: PainterId; reason: string };
  sandbox: { available: boolean; detail: string };
  providerKey: boolean;
}

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check { label: string; status: CheckStatus; detail: string; fix?: string[] }
export interface DoctorReport { checks: Check[]; ok: boolean }

function nodeIsRecentEnough(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  return major > MINIMUM_NODE[0] || (major === MINIMUM_NODE[0] && minor >= MINIMUM_NODE[1]);
}

export function buildReport(inputs: DoctorInputs): DoctorReport {
  const hints = installHints(inputs.platform);
  const checks: Check[] = [];
  const add = (check: Check) => { checks.push(check); };

  add(nodeIsRecentEnough(inputs.node)
    ? { label: "Node", status: "ok", detail: inputs.node }
    : { label: "Node", status: "fail", detail: `${inputs.node} is too old`, fix: [`Install Node ${MINIMUM_NODE.join(".")} or newer: https://nodejs.org`] });

  const caps = inputs.ffmpeg;
  add(caps
    ? { label: "FFmpeg", status: "ok", detail: caps.version ? `version ${caps.version}` : "found" }
    : { label: "FFmpeg", status: "fail", detail: "ffmpeg did not run", fix: hints });
  add(inputs.ffprobe
    ? { label: "ffprobe", status: "ok", detail: "found" }
    : { label: "ffprobe", status: "fail", detail: "ffprobe did not run (it comes with FFmpeg)", fix: hints });

  if (caps) {
    const missingEncoders = REQUIRED_ENCODERS.filter((name) => !caps.encoders.has(name));
    add(missingEncoders.length === 0
      ? { label: "Encoders", status: "ok", detail: REQUIRED_ENCODERS.join(", ") }
      : { label: "Encoders", status: "fail", detail: `missing: ${missingEncoders.join(", ")}`, fix: hints });
    const missingFilters = REQUIRED_FILTERS.filter((name) => !caps.filters.has(name));
    add(missingFilters.length === 0
      ? { label: "Filters", status: "ok", detail: "everything the editor uses is there" }
      : { label: "Filters", status: "fail", detail: `missing: ${missingFilters.join(", ")}`, fix: hints });
    if (caps.filters.has("ass")) add({ label: "Text and captions", status: "ok", detail: "drawn through libass" });
    else if (inputs.imageLibrary) add({ label: "Text and captions", status: "ok", detail: "drawn as images (this FFmpeg has no libass; SRT and VTT work, .ass files do not)" });
    else add({
      label: "Text and captions", status: "warn",
      detail: "this FFmpeg has no libass and the image library is not installed, so text overlays and captions will fail",
      fix: ["Use an FFmpeg with libass:", ...hints],
    });
  } else {
    add({ label: "Text and captions", status: "warn", detail: "cannot tell without FFmpeg" });
  }

  add(inputs.ffplay
    ? { label: "ffplay", status: "ok", detail: "found (the preview plays sound)" }
    : { label: "ffplay", status: "warn", detail: "not found: the preview plays without sound", fix: hints });
  add(inputs.painter.id === "sixel"
    ? { label: "Terminal picture", status: "ok", detail: `sharp Sixel picture (${inputs.painter.reason})` }
    : {
        label: "Terminal picture", status: "warn", detail: `block art (${inputs.painter.reason})`,
        fix: ["For a sharp picture use Windows Terminal or a terminal with Sixel, or set DUMBEDITOR_PREVIEW=sixel if yours supports it."],
      });
  add(inputs.sandbox.available
    ? { label: "Agent sandbox", status: "ok", detail: inputs.sandbox.detail }
    : { label: "Agent sandbox", status: "warn", detail: `${inputs.sandbox.detail} (the agent cannot run scripts until this is fixed)` });
  add(inputs.providerKey
    ? { label: "Provider key", status: "ok", detail: "OPENROUTER_API_KEY is set" }
    : { label: "Provider key", status: "warn", detail: "OPENROUTER_API_KEY is not set: the agent is off until you run `dumbeditor setup`" });

  return { checks, ok: checks.every((check) => check.status !== "fail") };
}

const MARK: Record<CheckStatus, string> = { ok: "[ok]  ", warn: "[warn]", fail: "[fail]" };

export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${MARK[check.status]} ${check.label}: ${check.detail}`);
    for (const fix of check.fix ?? []) lines.push(`         -> ${fix}`);
  }
  const failures = report.checks.filter((check) => check.status === "fail").length;
  lines.push("", failures === 0 ? "Everything the editor needs is in place." : `${failures} required thing${failures === 1 ? " is" : "s are"} missing.`);
  return lines.join("\n");
}

const runs = (command: string): Promise<boolean> =>
  runProcess(command, ["-version"], { timeoutMs: 8_000, maxOutputBytes: 64_000 }).then(() => true, () => false);

export async function gatherInputs(environment: NodeJS.ProcessEnv = process.env): Promise<DoctorInputs> {
  const [ffmpeg, ffprobe, ffplay, canvas, sandbox] = await Promise.all([
    loadCapabilities(), runs("ffprobe"), runs("ffplay"), loadCanvas(), localSandboxStatus().catch(() => ({ available: false, detail: "could not be checked" })),
  ]);
  return {
    node: process.version, platform: process.platform, ffmpeg, ffprobe, ffplay, imageLibrary: canvas !== null,
    painter: { id: detectPreviewBackend(environment), reason: explainBackend(environment) },
    sandbox, providerKey: Boolean(environment.OPENROUTER_API_KEY?.trim()),
  };
}

/** Prints the report and returns the exit code: 0 when nothing required is missing, 1 otherwise. */
export async function runDoctor(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const report = buildReport(await gatherInputs(environment));
  console.log(formatReport(report));
  return report.ok ? 0 : 1;
}
