import React from "react";
import { Box, Text } from "ink";
import type { AgentAsset } from "../core/agent-workspace.js";
import { formatUsd, type UsageSummary } from "../core/usage.js";
import type { VersionEntry } from "../types.js";

export function ProjectSidebar(props: {
  versions: VersionEntry[];
  currentId: string;
  model: string;
  permissionMode: "ask" | "auto";
  usage: UsageSummary;
  versionLimit: number;
  width: number;
  height: number;
}) {
  const room = Math.max(1, props.height - 10);
  const visible = props.versions.slice(0, room);
  return (
    <Box width={props.width} height={props.height} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">Session</Text>
      <Text wrap="truncate-end">{props.model}</Text>
      <Text dimColor>Permissions: {props.permissionMode}</Text>
      <Text color="yellow">Luna {formatUsd(props.usage.lunaUsd)}</Text>
      {props.usage.harnessUsd > 0 && <Text color="yellow">Harness {formatUsd(props.usage.harnessUsd)}</Text>}
      <Text dimColor>Total {formatUsd(props.usage.totalUsd)}</Text>
      <Text> </Text>
      <Text bold color="magenta">Versions</Text>
      {visible.map((version) => (
        <Text key={version.id} {...(version.id === props.currentId ? { color: "green" as const } : {})} wrap="truncate-end">
          {version.id === props.currentId ? "●" : "○"} {version.id} {shortText(version.action, props.width - 10)}
        </Text>
      ))}
      {props.versions.length > visible.length && <Text dimColor>+{props.versions.length - visible.length} more</Text>}
      <Text dimColor wrap="truncate-end">limit {props.versionLimit} · /version</Text>
    </Box>
  );
}

export function AssetsSidebar(props: { assets: AgentAsset[]; usage: UsageSummary; width: number; height: number }) {
  const room = Math.max(1, props.height - 5);
  const visible = [...props.assets].reverse().slice(0, room);
  return (
    <Box width={props.width} height={props.height} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">Assets <Text dimColor>⇧A</Text></Text>
      <Text color="yellow">Cost {formatUsd(props.usage.assetUsd)}</Text>
      {visible.length === 0 && <Text dimColor>No assets yet</Text>}
      {visible.map((asset) => (
        <Text key={asset.id} wrap="truncate-end">
          {assetIcon(asset.kind)} {shortText(asset.description, Math.max(4, props.width - 12))} <Text dimColor>{asset.costUsd === undefined ? "—" : formatUsd(asset.costUsd, asset.costEstimated)}</Text>
        </Text>
      ))}
      {props.assets.length > visible.length && <Text dimColor>+{props.assets.length - visible.length} more</Text>}
      <Text dimColor wrap="truncate-end">Shift+A to browse</Text>
    </Box>
  );
}

export function assetIcon(kind: AgentAsset["kind"]): string {
  if (kind === "image") return "▧";
  if (kind === "video") return "▶";
  if (kind === "audio" || kind === "music") return "♪";
  return "≡";
}

function shortText(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(1, limit - 1))}…`;
}
