import { Box, Text } from "ink";
import { inputViewport } from "./text-layout.js";

export function InputPanel(props: { value: string; cursor: number; width: number; busy: boolean }) {
  const viewport = inputViewport(props.value, props.cursor, Math.max(8, props.width - 4));
  return (
    <Box height={viewport.rows + 2} minHeight={viewport.rows + 2} flexDirection="column" borderStyle="round" borderColor={props.busy ? "yellow" : "gray"} paddingX={1} overflow="hidden">
      {viewport.lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          <Text color="cyan">{line.prefix}</Text>{line.before}{line.cursor && <Text inverse>{line.cursor}</Text>}{line.after}
        </Text>
      ))}
    </Box>
  );
}
