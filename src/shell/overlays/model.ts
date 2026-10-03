import { Input, matchesKey } from "@earendil-works/pi-tui";
import type { ProviderModel } from "../../core/models.js";
import type { DumbEditorSettings, ModelProvider, ModelSlot } from "../../core/settings.js";
import type { Loader } from "../state/shell-state.js";
import { bold, accent, dim, inverse, yellow } from "../views/style.js";
import { box, centered, isTextInput, listWindow, Panel, wrapIndex, type PanelContext } from "./frame.js";
import {
  capabilityDefinition, configuredCapability, configuredModel, filteredPickerModels, initialModelPicker, MODEL_CAPABILITIES,
  modelPricePresentation, providerName, type ModelCapability, type ModelPickerState, type ModelPickerStep,
} from "./model-picker-state.js";

export interface ModelPanelServices {
  settings(): DumbEditorSettings;
  keys(): { openai: boolean; openrouter: boolean };
  listModels(provider: ModelProvider, slot: ModelSlot): Promise<ProviderModel[]>;
  /** Save the choice. Reject with an Error to show its message in the panel and stay open. */
  save(choice: { capability: ModelCapability; provider: ModelProvider; slot: ModelSlot; model: ProviderModel }): Promise<void>;
  setLoader(loader: Loader | null): void;
  close(): void;
}

/** Pick a default model: capability, then provider, then a searchable list of that provider's models. */
export class ModelPanel extends Panel {
  picker: ModelPickerState = initialModelPicker();
  private request = 0;
  /** True while a choice is being saved, so a second Enter does not save it twice. */
  private saving = false;
  private readonly search = new Input({ prompt: "Search > " });

  constructor(context: PanelContext, private readonly services: ModelPanelServices) { super(context); }

  render(width: number): string[] {
    const modalWidth = Math.max(20, Math.min(96, width - 4));
    const modalHeight = Math.max(8, Math.min(26, this.rows - 2));
    const inner = Math.max(1, modalHeight - 2);
    const body = this.body(modalWidth - 6, inner - 2);
    const lines = [this.header(), ...body.slice(0, inner - 2)];
    while (lines.length < inner - 1) lines.push("");
    lines.push(this.footer());
    return centered(box(lines, modalWidth, { border: "round", color: accent, paddingX: 2 }), width, this.rows);
  }

  handleInput(data: string): void {
    const picker = this.picker;
    if (matchesKey(data, "escape") || matchesKey(data, "left")) { this.back(); return; }
    if (picker.loading) return;
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "tab")) {
      const count = picker.step === "capability" ? MODEL_CAPABILITIES.length
        : picker.step === "provider" ? capabilityDefinition(picker.capability).providers.length
          : filteredPickerModels(picker).length;
      if (count > 0) this.picker = { ...picker, selectedIndex: wrapIndex(picker.selectedIndex, matchesKey(data, "up") ? -1 : 1, count) };
    } else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      void this.choose();
      return;
    } else if (picker.step === "models" && !picker.error && (isTextInput(data) || matchesKey(data, "backspace") || matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+a") || matchesKey(data, "ctrl+e") || matchesKey(data, "delete"))) {
      const before = this.search.getValue();
      this.search.handleInput(data);
      if (this.search.getValue() !== before) this.picker = { ...picker, query: this.search.getValue(), selectedIndex: 0 };
    }
    this.context.requestRender();
  }

  private async choose(): Promise<void> {
    const picker = this.picker;
    if (picker.step === "capability") {
      const capability = MODEL_CAPABILITIES[picker.selectedIndex] ?? MODEL_CAPABILITIES[0]!;
      this.picker = { ...initialModelPicker(), step: "provider", capability: capability.id, slot: capability.slot };
      this.context.requestRender();
      return;
    }
    if (picker.step === "provider") {
      const capability = capabilityDefinition(picker.capability);
      await this.load(capability.providers[picker.selectedIndex] ?? capability.providers[0]!, capability.slot);
      return;
    }
    if (!picker.provider) return;
    if (picker.error) { await this.load(picker.provider, picker.slot); return; }
    const selected = filteredPickerModels(picker)[picker.selectedIndex];
    if (!selected || this.saving) return;
    this.saving = true;
    this.services.setLoader({ source: "Editor", stage: "Saving model default" });
    try {
      await this.services.save({ capability: picker.capability, provider: picker.provider, slot: picker.slot, model: selected });
      this.services.close();
    } catch (error) {
      this.picker = { ...this.picker, error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.saving = false;
      this.services.setLoader(null);
      this.context.requestRender();
    }
  }

  private async load(provider: ModelProvider, slot: ModelSlot): Promise<void> {
    const request = ++this.request;
    this.search.setValue("");
    this.picker = { ...this.picker, step: "models", provider, slot, models: [], query: "", selectedIndex: 0, loading: true, error: null };
    this.services.setLoader({ source: "Editor", stage: `Loading ${provider} ${slot} models` });
    this.context.requestRender();
    try {
      const models = await this.services.listModels(provider, slot);
      if (request !== this.request) return;
      this.picker = { ...this.picker, models, loading: false, error: null };
    } catch (error) {
      if (request !== this.request) return;
      this.picker = { ...this.picker, models: [], loading: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      if (request === this.request) this.services.setLoader(null);
      this.context.requestRender();
    }
  }

  private back(): void {
    this.request += 1;
    this.services.setLoader(null);
    const picker = this.picker;
    if (picker.step === "capability") { this.services.close(); return; }
    if (picker.step === "provider") this.picker = initialModelPicker();
    else {
      const capability = capabilityDefinition(picker.capability);
      this.picker = {
        ...initialModelPicker(), step: "provider", capability: picker.capability, slot: picker.slot,
        selectedIndex: Math.max(0, capability.providers.indexOf(picker.provider ?? capability.providers[0]!)),
      };
    }
    this.context.requestRender();
  }

  private header(): string {
    const picker = this.picker;
    const capability = capabilityDefinition(picker.capability);
    const path = picker.step === "capability" ? "Capability"
      : picker.step === "provider" ? `${capability.label} / provider` : `${capability.label} / ${providerName(picker.provider)}`;
    return `${bold(accent("Select default model"))}  ${dim(path)}`;
  }

  private footer(): string {
    const step: ModelPickerStep = this.picker.step;
    return dim(`Up/Down/Tab move | Enter ${step === "models" ? "select" : "open"}${step === "models" ? " | type to search | Ctrl+U clears" : ""} | Esc ${step === "capability" ? "close" : "back"}`);
  }

  private body(width: number, height: number): string[] {
    const picker = this.picker;
    const settings = this.services.settings();
    if (picker.step === "capability") {
      return ["", ...MODEL_CAPABILITIES.map((capability, index) => choice(index === picker.selectedIndex, capability.label, `${configuredCapability(settings, capability)} | ${capability.detail}`))];
    }
    if (picker.step === "provider") {
      const capability = capabilityDefinition(picker.capability);
      const keys = this.services.keys();
      return ["", ...capability.providers.map((provider, index) => {
        const active = picker.capability === "agent" && settings.agent.provider === provider;
        return choice(index === picker.selectedIndex, providerName(provider), `${keys[provider] ? "configured" : "key missing"} | ${configuredModel(settings, provider, capability.slot)}${active ? " | active" : ""}`);
      })];
    }
    return this.modelList(settings, width, height);
  }

  private modelList(settings: DumbEditorSettings, width: number, height: number): string[] {
    const picker = this.picker;
    this.search.focused = this.focused && !picker.loading;
    const models = filteredPickerModels(picker);
    const room = Math.max(3, height - 7);
    const { start, end } = listWindow(models.length, picker.selectedIndex, room);
    const current = configuredModel(settings, picker.provider, picker.slot);
    const price = modelPricePresentation(picker.provider, picker.slot);
    const columns = columnWidths(width);
    const lines = ["", ...box(this.search.render(Math.max(8, width - 4)), width, { border: "round", color: dim })];
    if (picker.loading) lines.push(yellow("Loading provider catalog..."));
    else if (picker.error) lines.push(yellow(picker.error), dim("Press Enter to retry."));
    else if (models.length === 0) lines.push(dim(`No models match "${picker.query}".`));
    else {
      lines.push(dim(`  ${cell("MODEL", columns.model)} ${cell(price.first, columns.price)} ${cell(price.second, columns.price)}`));
      for (const [offset, model] of models.slice(start, end).entries()) {
        const label = `${model.id === current ? "* " : ""}${model.name}${model.name === model.id ? "" : ` | ${model.id}`}`;
        const text = `${start + offset === picker.selectedIndex ? "> " : "  "}${cell(label, columns.model)} ${cell(model.inputPrice ?? "-", columns.price)} ${cell(model.outputPrice ?? "-", columns.price)}`;
        lines.push(start + offset === picker.selectedIndex ? inverse(accent(text)) : text);
      }
      lines.push(dim(`${models.length} models${models.length > room ? ` | showing ${start + 1}-${end}` : ""}`), dim(price.note));
    }
    return lines;
  }
}

function choice(selected: boolean, primary: string, secondary: string): string {
  const text = `${selected ? "> " : "  "}${primary}  ${secondary}`;
  return selected ? inverse(accent(text)) : text;
}

function columnWidths(width: number): { model: number; price: number } {
  const price = width >= 80 ? 18 : width >= 54 ? 12 : 8;
  return { model: Math.max(8, width - (price * 2) - 4), price };
}

function cell(value: string, width: number): string {
  if (value.length > width) return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`;
  return value.padEnd(width);
}
