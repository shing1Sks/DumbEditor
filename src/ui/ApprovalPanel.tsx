import { Box, Text } from "ink";
import type { ApprovalRequest } from "../core/approval.js";

export function ApprovalPanel(props: { request: ApprovalRequest; allowSelected: boolean; width: number; height: number }) {
  const parameters = props.request.parameters ? JSON.stringify(props.request.parameters) : null;
  return (
    <Box width={props.width} height={props.height} justifyContent="center" alignItems="center">
      <Box width={Math.min(86, props.width - 4)} flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={2} paddingY={1}>
        <Text bold color="yellow">Permission required</Text>
        <Text bold>{props.request.title}</Text>
        <Text wrap="wrap">{props.request.description}</Text>
        {props.request.provider && <Text>Provider: <Text color="cyan">{props.request.provider}</Text></Text>}
        {props.request.model && <Text>Model: <Text color="cyan">{props.request.model}</Text></Text>}
        {parameters && <Text dimColor wrap="truncate-end">Parameters: {parameters}</Text>}
        <Text> </Text>
        <Box gap={3}>
          <Text inverse={!props.allowSelected} {...(!props.allowSelected ? { color: "red" as const } : {})}> Deny </Text>
          <Text inverse={props.allowSelected} {...(props.allowSelected ? { color: "green" as const } : {})}> Allow once </Text>
        </Box>
        <Text dimColor>←/→ or Tab chooses · Enter confirms · Esc denies</Text>
      </Box>
    </Box>
  );
}
