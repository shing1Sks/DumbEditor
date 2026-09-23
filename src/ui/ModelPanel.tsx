import React from "react";
import { Box, Text } from "ink";
import type { ProviderModel } from "../core/models.js";
import { OPENROUTER_SLOTS, type DumbEditorSettings, type ModelProvider, type OpenRouterSlot } from "../core/settings.js";

export type ModelPickerStep = "provider" | "slot" | "models";

export interface ModelPickerState {
  step: ModelPickerStep;
  provider: ModelProvider | null;
  slot: OpenRouterSlot;
  models: ProviderModel[];
  query: string;
  selectedIndex: number;
  loading: boolean;
  error: string | null;
}

export function initialModelPicker(): ModelPickerState {
  return {
    step: "provider",
    provider: null,
    slot: "text",
    models: [],
    query: "",
    selectedIndex: 0,
    loading: false,
    error: null,
  };
}

export function filteredPickerModels(picker: ModelPickerState): ProviderModel[] {
  const query = picker.query.trim().toLowerCase();
  if (!query) return picker.models;
  return picker.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query));
}

export function ModelPanel(props: {
  picker: ModelPickerState;
  settings: DumbEditorSettings;
  keys: { openai: boolean; openrouter: boolean };
  width: number;
  height: number;
}) {
  const modalWidth = Math.max(20, Math.min(96, props.width - 4));
  const modalHeight = Math.max(8, Math.min(26, props.height - 2));
  return (
    <Box width={props.width} height={props.height} alignItems="center" justifyContent="center">
      <Box width={modalWidth} height={modalHeight} flexDirection="column" borderStyle="double" borderColor="cyan" paddingX={2}>
        <Header picker={props.picker} />
        {props.picker.step === "provider" && <ProviderChoices picker={props.picker} settings={props.settings} keys={props.keys} />}
        {props.picker.step === "slot" && <SlotChoices picker={props.picker} settings={props.settings} />}
        {props.picker.step === "models" && <ModelChoices picker={props.picker} settings={props.settings} height={modalHeight - 5} />}
        <Box flexGrow={1} />
        <Footer step={props.picker.step} />
      </Box>
    </Box>
  );
}

function Header({ picker }: { picker: ModelPickerState }) {
  const path = picker.step === "provider"
    ? "Provider"
    : picker.step === "slot"
      ? "OpenRouter / capability"
      : `${picker.provider === "openai" ? "OpenAI" : "OpenRouter"} / ${picker.slot}`;
  return <Text bold color="cyan">Select default model  <Text dimColor>{path}</Text></Text>;
}

function ProviderChoices(props: {
  picker: ModelPickerState;
  settings: DumbEditorSettings;
  keys: { openai: boolean; openrouter: boolean };
}) {
  const providers: Array<{ name: string; status: string; detail: string }> = [
    { name: "OpenAI", status: props.keys.openai ? "configured" : "key missing", detail: props.settings.models.openai.text },
    { name: "OpenRouter", status: props.keys.openrouter ? "configured" : "optional key missing", detail: "text, image, audio, music, video" },
  ];
  return <Box flexDirection="column" marginTop={1}>
    {providers.map((provider, index) => (
      <Choice key={provider.name} selected={index === props.picker.selectedIndex}
        primary={provider.name} secondary={`${provider.status} · ${provider.detail}`} />
    ))}
  </Box>;
}

function SlotChoices({ picker, settings }: { picker: ModelPickerState; settings: DumbEditorSettings }) {
  return <Box flexDirection="column" marginTop={1}>
    {OPENROUTER_SLOTS.map((slot, index) => (
      <Choice key={slot} selected={index === picker.selectedIndex} primary={capitalize(slot)} secondary={settings.models.openrouter[slot]} />
    ))}
  </Box>;
}

function ModelChoices({ picker, settings, height }: { picker: ModelPickerState; settings: DumbEditorSettings; height: number }) {
  const models = filteredPickerModels(picker);
  const room = Math.max(3, height - 4);
  const start = Math.min(Math.max(0, picker.selectedIndex - room + 1), Math.max(0, models.length - room));
  const current = picker.provider === "openai" ? settings.models.openai.text : settings.models.openrouter[picker.slot];
  return <Box flexDirection="column" marginTop={1}>
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">Search › </Text><Text>{picker.query}</Text><Text inverse> </Text>
    </Box>
    {picker.loading ? <Text color="yellow">Loading provider catalog…</Text>
      : picker.error ? <><Text color="yellow" wrap="truncate-end">{picker.error}</Text><Text dimColor>Press Enter to retry.</Text></>
        : models.length === 0 ? <Text dimColor>No models match “{picker.query}”.</Text>
          : models.slice(start, start + room).map((model, offset) => (
            <Choice key={model.id} selected={start + offset === picker.selectedIndex}
              primary={`${model.id === current ? "● " : ""}${model.name}`} secondary={model.id} />
          ))}
    {!picker.loading && !picker.error && <Text dimColor>{models.length} models{models.length > room ? ` · showing ${start + 1}-${Math.min(start + room, models.length)}` : ""}</Text>}
  </Box>;
}

function Choice({ selected, primary, secondary }: { selected: boolean; primary: string; secondary: string }) {
  return <Text {...(selected ? { color: "black" as const, backgroundColor: "cyan" as const } : {})} wrap="truncate-end">
    {selected ? "› " : "  "}{primary}  <Text dimColor={!selected}>{secondary}</Text>
  </Text>;
}

function Footer({ step }: { step: ModelPickerStep }) {
  return <Text dimColor>↑/↓/Tab move · Enter {step === "models" ? "select" : "open"}{step === "models" ? " · type to search · Backspace edits" : ""} · Esc {step === "provider" ? "close" : "back"}</Text>;
}

function capitalize(value: string): string {
  return value[0]?.toUpperCase() + value.slice(1);
}
