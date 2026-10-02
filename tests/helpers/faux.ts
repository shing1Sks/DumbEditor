import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type RegisterFauxProviderOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";

/** pi's scripted fake provider plus a Models collection that serves it. No network. */
export function makeFaux(options: RegisterFauxProviderOptions = {}) {
  const faux = fauxProvider(options);
  const models = createModels();
  models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}

export const call = (name: string, args: ToolCall["arguments"], id: string): ToolCall => fauxToolCall(name, args, { id });

/** An assistant message that calls tools. */
export const toolUse = (...calls: ToolCall[]): AssistantMessage => fauxAssistantMessage(calls, { stopReason: "toolUse" });

export const say = (text: string): AssistantMessage => fauxAssistantMessage(text);

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
