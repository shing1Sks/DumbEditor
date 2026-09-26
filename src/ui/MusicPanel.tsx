import { Box, Text } from "ink";
import type { MusicTrack } from "../core/music-catalog.js";

export function MusicPanel(props: {
  tracks: MusicTrack[];
  query: string;
  selectedIndex: number;
  selectedId: string | null;
  previewId: string | null;
  width: number;
  height: number;
}) {
  const availableRows = Math.max(1, props.height - 10);
  const start = Math.min(Math.max(0, props.selectedIndex - availableRows + 1), Math.max(0, props.tracks.length - availableRows));
  const visible = props.tracks.slice(start, start + availableRows);
  const highlighted = props.tracks[props.selectedIndex];
  return (
    <Box width={props.width} height={props.height} paddingX={2} paddingY={1} borderStyle="round" borderColor="cyan" flexDirection="column">
      <Text bold color="cyan">Background music  <Text dimColor>open license catalog</Text></Text>
      <Text>Search › {props.query}<Text inverse> </Text></Text>
      <Text dimColor>  TITLE                    MOOD                 LENGTH   LICENSE</Text>
      {visible.length === 0 ? <Text color="yellow">No tracks match this search.</Text> : visible.map((track, offset) => {
        const index = start + offset;
        const active = index === props.selectedIndex;
        const marker = props.previewId === track.id ? "▶" : props.selectedId === track.id ? "✓" : " ";
        const line = `${marker} ${fit(track.title, 24)} ${fit(track.moods.slice(0, 2).join(", "), 20)} ${fit(formatDuration(track.durationSeconds), 8)} CC BY 4.0`;
        return <Text key={track.id} {...(active ? { inverse: true, color: "cyan" as const } : {})}>{active ? "›" : " "} {line}</Text>;
      })}
      <Box marginTop={1} flexDirection="column">
        {highlighted ? <>
          <Text bold>{highlighted.title} · {highlighted.artist}</Text>
          <Text wrap="truncate-end">{highlighted.description}</Text>
          <Text dimColor wrap="truncate-end">{highlighted.license.attribution}</Text>
        </> : <Text dimColor>Try a mood such as bright, calm, reflective, or uplifting.</Text>}
      </Box>
      <Text dimColor>↑/↓ choose · Space preview/stop · Enter select · type to search · Ctrl+U clear · Delete unselect · Esc close</Text>
    </Box>
  );
}

function fit(value: string, width: number): string {
  const clipped = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return clipped.padEnd(width);
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
