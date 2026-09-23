import React from "react";
import { Box, Text } from "ink";
import type { ProviderModel } from "../core/models.js";
import { OPENROUTER_SLOTS, type DumbEditorSettings, type OpenRouterSlot } from "../core/settings.js";

export type ModelCatalogs = Partial<Record<`openai:text` | `openrouter:${OpenRouterSlot}`, ProviderModel[]>>;

export function ModelPanel(props: {
  settings: DumbEditorSettings;
  catalogs: ModelCatalogs;
  keys: { openai: boolean; openrouter: boolean };
  focus?: { provider: "openai" | "openrouter"; slot: OpenRouterSlot };
  error?: string;
  height: number;
}) {
  const focusKey = props.focus ? `${props.focus.provider}:${props.focus.slot}` as keyof ModelCatalogs : undefined;
  const focused = focusKey ? props.catalogs[focusKey] ?? [] : [];
  const listRoom = Math.max(0, props.height - 13);
  return (
    <Box height={props.height} flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Model defaults</Text>
      <Box flexDirection="row">
        <Box width="42%" flexDirection="column" paddingRight={1}>
          <Text bold>OpenAI <Text color={props.keys.openai ? "green" : "yellow"}>{props.keys.openai ? "configured" : "key missing"}</Text></Text>
          <ModelRow label="editor" model={props.settings.models.openai.text} count={props.catalogs["openai:text"]?.length} />
          <Text dimColor wrap="truncate-end">/model openai MODEL</Text>
        </Box>
        <Box width="58%" flexDirection="column">
          <Text bold>OpenRouter <Text color={props.keys.openrouter ? "green" : "yellow"}>{props.keys.openrouter ? "configured" : "optional key missing"}</Text></Text>
          {OPENROUTER_SLOTS.map((slot) => (
            <ModelRow key={slot} label={slot} model={props.settings.models.openrouter[slot]} count={props.catalogs[`openrouter:${slot}`]?.length} />
          ))}
        </Box>
      </Box>
      {props.focus && <>
        <Text bold color="magenta">Available: {props.focus.provider} {props.focus.slot}</Text>
        {focused.slice(0, listRoom).map((model) => <Text key={model.id} wrap="truncate-end">  {model.id}</Text>)}
        {focused.length > listRoom && <Text dimColor>  +{focused.length - listRoom} more in provider catalog</Text>}
      </>}
      {props.error && <Text color="yellow" wrap="truncate-end">Catalog: {props.error}</Text>}
      <Text dimColor wrap="truncate-end">List: /model openai or /model openrouter TYPE · Set: add MODEL · Esc closes</Text>
    </Box>
  );
}

function ModelRow({ label, model, count }: { label: string; model: string; count: number | undefined }) {
  return <Text wrap="truncate-end"><Text dimColor>{label.padEnd(6)}</Text> {model}{count === undefined ? "" : ` (${count})`}</Text>;
}
