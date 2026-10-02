import { Box, Text } from "ink";
import type { ApprovalDecision, EngineEvent } from "../core/engine/events.js";

export type ApprovalView = Extract<EngineEvent, { type: "approval_request" }>;

/** Choices shown for a request, last one being the safe default. */
export function approvalOptions(request: ApprovalView): string[] {
  return request.kind === "budget" ? ["Continue", "Stop"] : ["Allow once", "Allow this session", "Deny"];
}

export function approvalDecision(request: ApprovalView, index: number): ApprovalDecision {
  if (request.kind === "budget") return index === 0 ? "once" : "deny";
  return (["once", "session", "deny"] as const)[index] ?? "deny";
}

const RISK_NOTE: Record<string, string> = {
  spend: "This can spend money with a model provider.",
  code: "This runs custom FFmpeg or a script the agent wrote.",
};

export function ApprovalPanel(props: { request: ApprovalView; options: string[]; selectedIndex: number; width: number; height: number }) {
  const { request } = props;
  const args = request.args === undefined ? null : JSON.stringify(request.args);
  return (
    <Box width={props.width} height={props.height} justifyContent="center" alignItems="center">
      <Box width={Math.min(86, props.width - 4)} flexDirection="column" borderStyle="double" borderColor="yellow" paddingX={2} paddingY={1}>
        <Text bold color="yellow">{request.kind === "budget" ? "Spend limit reached" : "Permission required"}</Text>
        <Text bold wrap="wrap">{request.summary}</Text>
        {RISK_NOTE[request.risk] && <Text wrap="wrap">{RISK_NOTE[request.risk]}</Text>}
        {args && <Text dimColor wrap="truncate-end">Arguments: {args}</Text>}
        <Text> </Text>
        <Box gap={2}>
          {props.options.map((option, index) => (
            <Text key={option} inverse={index === props.selectedIndex} {...(index === props.selectedIndex ? { color: index === props.options.length - 1 ? "red" as const : "green" as const } : {})}> {option} </Text>
          ))}
        </Box>
        <Text dimColor>←/→ or Tab chooses · Enter confirms · Esc denies</Text>
      </Box>
    </Box>
  );
}
