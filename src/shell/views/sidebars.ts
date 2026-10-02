import type { Component } from "@earendil-works/pi-tui";
import type { AgentAsset } from "../../core/agent-workspace.js";
import { formatUsd } from "../../core/usage.js";
import type { ShellState } from "../state/shell-state.js";
import { accent, bold, chip, dim, faint, fitLine, gray, muted, onPanel, shortProjectName, shorten, warn } from "./style.js";

export function assetIcon(kind: AgentAsset["kind"]): string {
  if (kind === "image") return "▧";
  if (kind === "video") return "▶";
  if (kind === "audio" || kind === "music") return "♪";
  return "≡";
}

/** Draw lines inside a single-line box exactly `width` wide and `height` tall. */
export function boxed(lines: string[], width: number, height: number): string[] {
  const inner = Math.max(1, width - 2);
  const content = Math.max(1, inner - 2);
  const top = gray(`┌${"─".repeat(inner)}┐`);
  const bottom = gray(`└${"─".repeat(inner)}┘`);
  const rows: string[] = [];
  for (let index = 0; index < Math.max(0, height - 2); index += 1) {
    rows.push(`${gray("│")} ${fitLine(lines[index] ?? "", content)} ${gray("│")}`);
  }
  return [top, ...rows, bottom].slice(0, Math.max(2, height));
}

const PADDING = 2;

/** A side column on a soft background: a blank row above, two columns of space on each side, a blank row below. */
function panel(lines: string[], width: number, height: number): string[] {
  const content = Math.max(1, width - PADDING * 2);
  const pad = " ".repeat(PADDING);
  return Array.from({ length: height }, (_, index) => onPanel(`${pad}${fitLine(lines[index - 1] ?? "", content)}${pad}`));
}

const heading = (text: string): string => bold(muted(text));

/** Left of the video: the project, the model and the spend, then the version list. */
export class ProjectSidebarView implements Component {
  constructor(private readonly state: ShellState, private readonly bandRows: () => number) {}

  render(width: number): string[] {
    const { state } = this;
    const height = this.bandRows();
    const room = Math.max(1, height - 11);
    const inner = Math.max(1, width - PADDING * 2);
    const visible = state.versions.slice(0, room);
    const lines = [
      heading("PROJECT"),
      bold(shorten(shortProjectName(state.projectName ?? "No project"), inner)),
      muted(shorten(state.agentModel, inner)),
      `${chip(state.permissionMode, state.permissionMode === "auto" ? warn : muted)} ${muted(formatUsd(state.usage.totalUsd))}`,
      "",
      heading("VERSIONS"),
      ...visible.map((version) => {
        const current = version.id === state.versionId;
        const text = `${current ? "●" : "○"} ${version.id} ${shorten(version.action, Math.max(4, inner - 9))}`;
        return current ? accent(text) : muted(text);
      }),
      ...(state.versions.length > visible.length ? [faint(`+${state.versions.length - visible.length} more`)] : []),
      "",
      faint(`limit ${state.versionLimit} · /version`),
    ];
    return panel(lines, width, height);
  }

  invalidate(): void { /* stateless */ }
}

/** Right of the video: generated and imported assets, newest first, with what they cost. */
export class AssetsSidebarView implements Component {
  constructor(private readonly state: ShellState, private readonly bandRows: () => number) {}

  render(width: number): string[] {
    const { state } = this;
    const height = this.bandRows();
    const room = Math.max(1, height - 8);
    const inner = Math.max(1, width - PADDING * 2);
    const visible = [...state.assets].reverse().slice(0, room);
    const lines = [
      heading("ASSETS"),
      muted(`${formatUsd(state.usage.assetUsd)} spent`),
      "",
      ...(visible.length === 0 ? [dim(faint("None yet"))] : visible.map((asset) =>
        `${accent(assetIcon(asset.kind))} ${shorten(asset.description, Math.max(4, inner - 10))} ${faint(asset.costUsd === undefined ? "—" : formatUsd(asset.costUsd, asset.costEstimated))}`)),
      ...(state.assets.length > visible.length ? [faint(`+${state.assets.length - visible.length} more`)] : []),
      "",
      faint("Ctrl+O browse"),
    ];
    return panel(lines, width, height);
  }

  invalidate(): void { /* stateless */ }
}
