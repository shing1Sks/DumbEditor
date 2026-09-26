import React from "react";
import { basename } from "node:path";
import { Box, Text } from "ink";
import type { ProjectSummary } from "../core/project.js";

export function ProjectsPanel(props: {
  projects: ProjectSummary[];
  selectedIndex: number;
  activeProjectDir?: string;
  width: number;
  height: number;
}) {
  const capacity = Math.max(1, props.height - 4);
  const start = Math.min(
    Math.max(0, props.selectedIndex - capacity + 1),
    Math.max(0, props.projects.length - capacity),
  );
  const visible = props.projects.slice(start, start + capacity);
  return (
    <Box width={props.width} height={props.height} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} overflow="hidden">
      <Box height={1} minHeight={1} justifyContent="space-between">
        <Text bold color="cyan">Projects</Text>
        <Text dimColor>{props.projects.length} saved</Text>
      </Box>
      {visible.length === 0 && <Text dimColor>No saved projects found. Open a video to create one.</Text>}
      {visible.map((project, offset) => {
        const index = start + offset;
        const selected = index === props.selectedIndex;
        const active = samePath(project.projectDir, props.activeProjectDir);
        return (
          <Text key={project.projectDir} {...(selected ? { color: "cyan" as const, inverse: true } : {})} wrap="truncate-end">
            {selected ? "›" : " "} {active ? "●" : "○"} {project.name}  <Text dimColor>{basename(project.sourcePath)} · {project.versionCount} versions · {project.currentVersionId}</Text>
          </Text>
        );
      })}
      <Text dimColor>↑/↓ browse · Enter open · Esc close</Text>
    </Box>
  );
}

function samePath(left: string, right: string | undefined): boolean {
  return Boolean(right) && left.toLowerCase() === right?.toLowerCase();
}
