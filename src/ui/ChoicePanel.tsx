import { Box, Text } from "ink";
import type { ChoiceRequest } from "../core/choice.js";

export interface ChoicePanelState {
  selectedIndex: number;
  customActive: boolean;
  customText: string;
  customCursor: number;
}

export function ChoicePanel(props: { request: ChoiceRequest; state: ChoicePanelState; width: number; height: number }) {
  const panelWidth = Math.min(92, props.width - 4);
  const customWidth = Math.max(8, panelWidth - 8);
  const customStart = Math.max(0, Math.min(props.state.customCursor - customWidth + 1, props.state.customText.length - customWidth));
  const customText = props.state.customText.slice(customStart, customStart + customWidth);
  const customCursor = props.state.customCursor - customStart;
  return (
    <Box width={props.width} height={props.height} justifyContent="center" alignItems="center">
      <Box width={panelWidth} height={Math.max(4, props.height - 2)} flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2} paddingY={1} overflow="hidden">
        <Text bold color="cyan">Choose a direction</Text>
        <Text wrap="wrap">{props.request.question}</Text>
        <Text> </Text>
        {props.request.options.map((option, index) => (
          <Text key={`${index}-${option}`} inverse={!props.state.customActive && index === props.state.selectedIndex} wrap="truncate-end">
            {!props.state.customActive && index === props.state.selectedIndex ? "› " : "  "}{option}
          </Text>
        ))}
        {props.request.allowCustom && <>
          <Text> </Text>
          <Text {...(props.state.customActive ? { color: "cyan" as const } : {})}>Custom answer</Text>
          <Box height={3} minHeight={3} borderStyle="round" borderColor={props.state.customActive ? "cyan" : "gray"} paddingX={1} overflow="hidden">
            <Text wrap="truncate-end">{customStart > 0 ? "…" : ""}{customText.slice(0, customCursor)}</Text>
            <Text inverse={props.state.customActive}>{customText[customCursor] ?? " "}</Text>
            <Text wrap="truncate-end">{customText.slice(customCursor + (customCursor < customText.length ? 1 : 0))}</Text>
          </Box>
        </>}
        <Text dimColor>↑/↓ chooses · Tab custom answer · Enter sends · Esc cancels</Text>
      </Box>
    </Box>
  );
}
