import React from "react";
import { Box, Text } from "ink";
import type { MediaInfo, Selection, VersionEntry } from "../types.js";
import { formatTime } from "../core/time.js";

export function VersionsSidebar(props: { versions: VersionEntry[]; currentId: string; width: number; height: number }) {
  const room = Math.max(1, props.height - 4);
  const visible = props.versions.slice(0, room);
  return (
    <Box width={props.width} height={props.height} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="magenta">Versions</Text>
      {visible.map((version) => (
        <Box key={version.id} flexDirection="column">
          <Text {...(version.id === props.currentId ? { color: "green" as const } : {})} wrap="truncate-end">
            {version.id === props.currentId ? "●" : "○"} {version.id} {shortAction(version.action, props.width - 10)}
          </Text>
        </Box>
      ))}
      {props.versions.length > visible.length && <Text dimColor>+{props.versions.length - visible.length} more</Text>}
      <Text dimColor wrap="truncate-end">/version for details</Text>
    </Box>
  );
}

export function SessionSidebar(props: {
  media: MediaInfo | null;
  selection: Selection;
  versionLimit: number;
  model: string;
  width: number;
  height: number;
}) {
  return (
    <Box width={props.width} height={props.height} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color="cyan">Session</Text>
      <Text dimColor>Agent</Text>
      <Text wrap="truncate-end">{props.model}</Text>
      {props.media && <>
        <Text dimColor>Media</Text>
        <Text>{props.media.width}x{props.media.height}</Text>
        <Text>{formatTime(props.media.duration)}</Text>
      </>}
      <Text dimColor>Selection</Text>
      <Text wrap="truncate-end">{selectionText(props.selection)}</Text>
      <Text dimColor>Retention</Text>
      <Text>{props.versionLimit} edits</Text>
      <Text dimColor wrap="truncate-end">/model · /version-limits</Text>
    </Box>
  );
}

function shortAction(action: string, limit: number): string {
  const clean = action.replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, Math.max(1, limit - 1))}…`;
}

function selectionText(selection: Selection): string {
  if (selection.in === null && selection.out === null) return "none";
  return `${selection.in === null ? "-" : formatTime(selection.in)} → ${selection.out === null ? "-" : formatTime(selection.out)}`;
}
