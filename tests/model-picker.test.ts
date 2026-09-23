import assert from "node:assert/strict";
import test from "node:test";
import { filteredPickerModels, initialModelPicker } from "../src/ui/ModelPanel.js";

const models = [
  { id: "gpt-6-luna", name: "GPT-6 Luna" },
  { id: "gpt-6-sol", name: "GPT-6 Sol" },
  { id: "openai/gpt-image", name: "OpenAI Image" },
];

test("opens the model picker at provider selection", () => {
  const picker = initialModelPicker();
  assert.equal(picker.step, "provider");
  assert.equal(picker.selectedIndex, 0);
  assert.equal(picker.query, "");
});

test("filters provider models by display name or model ID", () => {
  const picker = { ...initialModelPicker(), step: "models" as const, provider: "openai" as const, models, query: "luna" };
  assert.deepEqual(filteredPickerModels(picker).map((model) => model.id), ["gpt-6-luna"]);
  assert.deepEqual(filteredPickerModels({ ...picker, query: "OPENAI/" }).map((model) => model.id), ["openai/gpt-image"]);
  assert.equal(filteredPickerModels({ ...picker, query: "missing" }).length, 0);
});
