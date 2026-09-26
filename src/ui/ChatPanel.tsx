import { Box, Text } from "ink";
import type { ChatLine } from "./text-layout.js";

export function ChatPanel(props: {
  lines: ChatLine[];
  height: number;
  width: number;
  totalRows: number;
  startRow: number;
  endRow: number;
  maxScroll: number;
  scrollRows: number;
  focused?: boolean;
}) {
  const contentHeight = Math.max(1, props.height - 1);
  const title = props.focused ? "Conversation focus" : "Conversation";
  const position = props.totalRows === 0 ? "empty" : `${props.startRow + 1}-${props.endRow} / ${props.totalRows}`;
  return (
    <Box width={props.width} height={props.height} minHeight={props.height} flexDirection="column" overflow="hidden">
      <Box height={1} minHeight={1} justifyContent="space-between">
        <Text bold color={props.focused ? "cyan" : "gray"}>{title}</Text>
        <Text dimColor>{position}{props.focused ? " · Ctrl+G/Esc minimize" : " · ↑/↓ or PgUp/PgDn"}</Text>
      </Box>
      {Array.from({ length: contentHeight }, (_, index) => {
        const line = props.lines[index];
        return (
          <Box key={index} height={1} minHeight={1} width={props.width} overflow="hidden">
            <Box flexGrow={1} overflow="hidden">
              {line ? <Text wrap="truncate-end">
                <Text color={line.role === "user" ? "cyan" : "magenta"}>{line.prefix}</Text>{line.text}
              </Text> : <Text> </Text>}
            </Box>
            <Text dimColor>{scrollGlyph(index, contentHeight, props.maxScroll, props.scrollRows)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function scrollGlyph(row: number, height: number, maxScroll: number, scrollRows: number): string {
  if (maxScroll <= 0 || height <= 1) return " ";
  const thumb = Math.round(((maxScroll - Math.min(maxScroll, scrollRows)) / maxScroll) * (height - 1));
  return row === thumb ? "█" : "│";
}
