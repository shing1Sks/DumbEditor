import { Box, Text } from "ink";
import type { ProviderModel } from "../core/models.js";
import type { DumbEditorSettings, ModelProvider, ModelSlot, OpenAISlot, OpenRouterSlot } from "../core/settings.js";

export type ModelCapability = "agent" | "image" | "audio" | "music" | "video" | "transcription" | "speech";
export type ModelPickerStep = "capability" | "provider" | "models";

interface CapabilityDefinition {
  id: ModelCapability;
  label: string;
  detail: string;
  slot: ModelSlot;
  providers: ModelProvider[];
}

export const MODEL_CAPABILITIES: CapabilityDefinition[] = [
  { id: "agent", label: "Base agent", detail: "plans edits and runs tools", slot: "text", providers: ["openai", "openrouter"] },
  { id: "image", label: "Image", detail: "generated overlays and artwork", slot: "image", providers: ["openrouter"] },
  { id: "audio", label: "Audio", detail: "generated sound and speech", slot: "audio", providers: ["openrouter"] },
  { id: "music", label: "Music", detail: "generated background music", slot: "music", providers: ["openrouter"] },
  { id: "video", label: "Video", detail: "generated clips", slot: "video", providers: ["openrouter"] },
  { id: "transcription", label: "Transcription", detail: "speech to subtitles", slot: "transcription", providers: ["openai"] },
  { id: "speech", label: "Speech", detail: "text to speech", slot: "speech", providers: ["openai"] },
];

export interface ModelPickerState {
  step: ModelPickerStep;
  capability: ModelCapability;
  provider: ModelProvider | null;
  slot: ModelSlot;
  models: ProviderModel[];
  query: string;
  selectedIndex: number;
  loading: boolean;
  error: string | null;
}

export function initialModelPicker(): ModelPickerState {
  return {
    step: "capability",
    capability: "agent",
    provider: null,
    slot: "text",
    models: [],
    query: "",
    selectedIndex: 0,
    loading: false,
    error: null,
  };
}

export function capabilityDefinition(capability: ModelCapability): CapabilityDefinition {
  return MODEL_CAPABILITIES.find((item) => item.id === capability) ?? MODEL_CAPABILITIES[0]!;
}

export function filteredPickerModels(picker: ModelPickerState): ProviderModel[] {
  const query = picker.query.trim().toLowerCase();
  if (!query) return picker.models;
  return picker.models.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(query));
}

export function modelPricePresentation(provider: ModelProvider | null, slot: ModelSlot): {
  first: string;
  second: string;
  note: string;
} {
  if (provider === "openai" && slot === "transcription") {
    return { first: "PRICE", second: "BASIS", note: "Transcription pricing is estimated from audio duration." };
  }
  if (provider === "openai" && slot === "speech") {
    return { first: "TEXT INPUT", second: "AUDIO OUTPUT", note: "Speech prices show the provider's text and audio token rates." };
  }
  if (provider === "openrouter" && slot === "image") {
    return { first: "INPUT RATE", second: "OUTPUT RATE", note: "Image rates show their billing unit; ranges cover provider variants." };
  }
  if (provider === "openrouter" && slot === "audio") {
    return { first: "INPUT RATE", second: "OUTPUT RATE", note: "Audio rates show whether billing uses tokens or input characters." };
  }
  if (provider === "openrouter" && slot === "music") {
    return { first: "PRICE", second: "BASIS", note: "Music prices are per generated song or clip." };
  }
  if (provider === "openrouter" && slot === "video") {
    return { first: "FROM", second: "UP TO", note: "Video rates vary by resolution, audio, input type, and generation mode." };
  }
  return { first: "INPUT / 1M", second: "OUTPUT / 1M", note: "Token prices are USD per 1M tokens." };
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
        {props.picker.step === "capability" && <CapabilityChoices picker={props.picker} settings={props.settings} />}
        {props.picker.step === "provider" && <ProviderChoices picker={props.picker} settings={props.settings} keys={props.keys} />}
        {props.picker.step === "models" && <ModelChoices picker={props.picker} settings={props.settings} height={modalHeight - 5} width={modalWidth - 6} />}
        <Box flexGrow={1} />
        <Footer step={props.picker.step} />
      </Box>
    </Box>
  );
}

function Header({ picker }: { picker: ModelPickerState }) {
  const capability = capabilityDefinition(picker.capability);
  const path = picker.step === "capability"
    ? "Capability"
    : picker.step === "provider"
      ? `${capability.label} / provider`
      : `${capability.label} / ${providerName(picker.provider)}`;
  return <Text bold color="cyan">Select default model  <Text dimColor>{path}</Text></Text>;
}

function CapabilityChoices({ picker, settings }: { picker: ModelPickerState; settings: DumbEditorSettings }) {
  return <Box flexDirection="column" marginTop={1}>
    {MODEL_CAPABILITIES.map((capability, index) => (
      <Choice key={capability.id} selected={index === picker.selectedIndex} primary={capability.label}
        secondary={`${configuredCapability(settings, capability)} | ${capability.detail}`} />
    ))}
  </Box>;
}

function ProviderChoices(props: {
  picker: ModelPickerState;
  settings: DumbEditorSettings;
  keys: { openai: boolean; openrouter: boolean };
}) {
  const capability = capabilityDefinition(props.picker.capability);
  return <Box flexDirection="column" marginTop={1}>
    {capability.providers.map((provider, index) => {
      const configured = configuredModel(props.settings, provider, capability.slot);
      const active = props.picker.capability === "agent" && props.settings.agent.provider === provider;
      return <Choice key={provider} selected={index === props.picker.selectedIndex} primary={providerName(provider)}
        secondary={`${props.keys[provider] ? "configured" : "key missing"} | ${configured}${active ? " | active" : ""}`} />;
    })}
  </Box>;
}

function ModelChoices({ picker, settings, height, width }: { picker: ModelPickerState; settings: DumbEditorSettings; height: number; width: number }) {
  const models = filteredPickerModels(picker);
  const room = Math.max(3, height - 6);
  const start = Math.min(Math.max(0, picker.selectedIndex - room + 1), Math.max(0, models.length - room));
  const current = configuredModel(settings, picker.provider, picker.slot);
  const price = modelPricePresentation(picker.provider, picker.slot);
  return <Box flexDirection="column" marginTop={1}>
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">Search &gt; </Text><Text>{picker.query}</Text><Text inverse> </Text>
    </Box>
    {picker.loading ? <Text color="yellow">Loading provider catalog...</Text>
      : picker.error ? <><Text color="yellow" wrap="truncate-end">{picker.error}</Text><Text dimColor>Press Enter to retry.</Text></>
        : models.length === 0 ? <Text dimColor>No models match "{picker.query}".</Text>
          : <>
            <ModelColumns width={width} first={price.first} second={price.second} />
            {models.slice(start, start + room).map((model, offset) => (
              <ModelChoice key={model.id} model={model} current={model.id === current}
                selected={start + offset === picker.selectedIndex} width={width} />
            ))}
          </>}
    {!picker.loading && !picker.error && <Text dimColor>{models.length} models{models.length > room ? ` | showing ${start + 1}-${Math.min(start + room, models.length)}` : ""}</Text>}
    {!picker.loading && !picker.error && models.length > 0 && <Text dimColor>{price.note}</Text>}
  </Box>;
}

function ModelColumns({ width, first, second }: { width: number; first: string; second: string }) {
  const columns = columnWidths(width);
  return <Text dimColor>{`  ${cell("MODEL", columns.model)} ${cell(first, columns.price)} ${cell(second, columns.price)}`}</Text>;
}

function ModelChoice({ model, current, selected, width }: {
  model: ProviderModel;
  current: boolean;
  selected: boolean;
  width: number;
}) {
  const columns = columnWidths(width);
  const label = `${current ? "* " : ""}${model.name}${model.name === model.id ? "" : ` | ${model.id}`}`;
  const row = `${selected ? "> " : "  "}${cell(label, columns.model)} ${cell(model.inputPrice ?? "-", columns.price)} ${cell(model.outputPrice ?? "-", columns.price)}`;
  return <Text {...(selected ? { color: "black" as const, backgroundColor: "cyan" as const } : {})}>{row}</Text>;
}

function columnWidths(width: number): { model: number; price: number } {
  const price = width >= 80 ? 18 : width >= 54 ? 12 : 8;
  return { model: Math.max(8, width - (price * 2) - 4), price };
}

function cell(value: string, width: number): string {
  if (value.length > width) return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
  return value.padEnd(width);
}

function Choice({ selected, primary, secondary }: { selected: boolean; primary: string; secondary: string }) {
  return <Text {...(selected ? { color: "black" as const, backgroundColor: "cyan" as const } : {})} wrap="truncate-end">
    {selected ? "> " : "  "}{primary}  <Text dimColor={!selected}>{secondary}</Text>
  </Text>;
}

function Footer({ step }: { step: ModelPickerStep }) {
  return <Text dimColor>Up/Down/Tab move | Enter {step === "models" ? "select" : "open"}{step === "models" ? " | type to search | Backspace edits" : ""} | Esc {step === "capability" ? "close" : "back"}</Text>;
}

function configuredCapability(settings: DumbEditorSettings, capability: CapabilityDefinition): string {
  if (capability.id === "agent") {
    return `${providerName(settings.agent.provider)} | ${settings.models[settings.agent.provider].text}`;
  }
  const provider = capability.providers[0]!;
  return `${providerName(provider)} | ${configuredModel(settings, provider, capability.slot)}`;
}

function configuredModel(settings: DumbEditorSettings, provider: ModelProvider | null, slot: ModelSlot): string {
  if (provider === "openai") return settings.models.openai[slot as OpenAISlot] ?? "";
  if (provider === "openrouter") return settings.models.openrouter[slot as OpenRouterSlot] ?? "";
  return "";
}

function providerName(provider: ModelProvider | null): string {
  return provider === "openrouter" ? "OpenRouter" : "OpenAI";
}
