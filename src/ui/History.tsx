import { Box, Text } from "ink";
import type { VersionEntry } from "../types.js";
import { formatTime } from "../core/time.js";

export function History({ versions, currentId }: { versions: VersionEntry[]; currentId: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">Version history</Text>
      {versions.map((version) => (
        <Text key={version.id} {...(version.id === currentId ? { color: "green" as const } : {})}>
          {version.id === currentId ? "●" : "○"} {version.id}  {formatTime(version.duration)}  {version.action}
        </Text>
      ))}
      <Text dimColor>Use /revert v0001 · /version all · Esc to close</Text>
    </Box>
  );
}
