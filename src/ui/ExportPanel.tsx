import { Box, Text } from "ink";
import { EXPORT_PRESET_DETAILS, type ExportFormat, type ExportPreset } from "../core/export.js";

export type ExportFocus = "path" | "format" | "compression";

export interface ExportPanelState {
  destination: string;
  cursor: number;
  format: ExportFormat;
  preset: ExportPreset;
  focus: ExportFocus;
}

export function ExportPanel(props: { state: ExportPanelState; width: number; height: number }) {
  const modalWidth = Math.max(36, Math.min(96, props.width - 4));
  const preset = EXPORT_PRESET_DETAILS.find((item) => item.id === props.state.preset) ?? EXPORT_PRESET_DETAILS[2]!;
  return (
    <Box width={props.width} height={props.height} alignItems="center" justifyContent="center">
      <Box width={modalWidth} flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1}>
        <Text bold color="cyan">Export video</Text>
        <Text dimColor>Destination</Text>
        <Box borderStyle="round" borderColor={props.state.focus === "path" ? "cyan" : "gray"} paddingX={1}>
          <Text>{props.state.destination.slice(0, props.state.cursor)}</Text>
          <Text inverse={props.state.focus === "path"}>{props.state.destination[props.state.cursor] ?? " "}</Text>
          <Text>{props.state.destination.slice(props.state.cursor + (props.state.cursor < props.state.destination.length ? 1 : 0))}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Format</Text>
          <Text {...(props.state.focus === "format" ? { color: "cyan" as const } : {})}>
            {props.state.format === "mp4" ? "› " : "  "}[ MP4 ]    {props.state.format === "mkv" ? "› " : "  "}[ MKV ]
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Compression</Text>
          {EXPORT_PRESET_DETAILS.map((item) => <Text key={item.id}
            {...(item.id === props.state.preset && props.state.focus === "compression" ? { color: "black" as const, backgroundColor: "cyan" as const } : {})}>
            {item.id === props.state.preset ? "›" : " "} {item.label.padEnd(18)} <Text dimColor={item.id !== props.state.preset}>{item.video} · {item.audio}</Text>
          </Text>)}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text>{preset.description}</Text>
          <Text dimColor>MP4 is broadly compatible. MKV is flexible for local playback and archiving.</Text>
        </Box>
        <Box flexGrow={1} />
        <Text dimColor>Tab section · arrows edit/select · type destination · Enter export · Esc close</Text>
      </Box>
    </Box>
  );
}
