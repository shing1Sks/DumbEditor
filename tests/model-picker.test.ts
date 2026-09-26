import assert from "node:assert/strict";
import test from "node:test";
import { formatImagePriceFields, formatPerMillionPrice, formatVideoPriceFields } from "../src/core/models.js";
import { filteredPickerModels, initialModelPicker, modelPricePresentation } from "../src/ui/ModelPanel.js";

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

test("presents OpenAI transcription and speech pricing by their billing units", () => {
  assert.deepEqual(modelPricePresentation("openai", "transcription"), {
    first: "PRICE",
    second: "BASIS",
    note: "Transcription pricing is estimated from audio duration.",
  });
  assert.deepEqual(modelPricePresentation("openai", "speech"), {
    first: "TEXT INPUT",
    second: "AUDIO OUTPUT",
    note: "Speech prices show the provider's text and audio token rates.",
  });
});

test("filters provider models by display name or model ID", () => {
  const picker = { ...initialModelPicker(), step: "models" as const, provider: "openai" as const, models, query: "luna" };
  assert.deepEqual(filteredPickerModels(picker).map((model) => model.id), ["gpt-6-luna"]);
  assert.deepEqual(filteredPickerModels({ ...picker, query: "OPENAI/" }).map((model) => model.id), ["openai/gpt-image"]);
  assert.equal(filteredPickerModels({ ...picker, query: "missing" }).length, 0);
});

test("formats provider token prices per million tokens", () => {
  assert.equal(formatPerMillionPrice("0.0000001"), "$0.10");
  assert.equal(formatPerMillionPrice("0.00003"), "$30.00");
  assert.equal(formatPerMillionPrice("0"), "$0");
  assert.equal(formatPerMillionPrice("unknown"), undefined);
});

test("formats video SKU prices with their actual billing unit", () => {
  assert.deepEqual(formatVideoPriceFields({
    duration_seconds_720p: "0.10",
    duration_seconds_1080p: "0.20",
  }), { inputPrice: "$0.10/sec", outputPrice: "$0.20/sec" });
  assert.deepEqual(formatVideoPriceFields({ cents_per_second_output: "3" }), { inputPrice: "$0.03/sec" });
  assert.deepEqual(formatVideoPriceFields({ video_tokens: "0.0000035" }), { inputPrice: "$3.50/M tok" });
});

test("formats image endpoint price ranges and capability-specific headings", () => {
  assert.deepEqual(formatImagePriceFields([
    { billable: "input_image", unit: "image", cost_usd: 0.003 },
    { billable: "output_image", unit: "image", cost_usd: 0.04, variant: "1k" },
    { billable: "output_image", unit: "image", cost_usd: 0.075, variant: "2k" },
  ]), { inputPrice: "$0.003/img", outputPrice: "$0.04–$0.075/img" });
  assert.deepEqual(modelPricePresentation("openrouter", "video"), {
    first: "FROM",
    second: "UP TO",
    note: "Video rates vary by resolution, audio, input type, and generation mode.",
  });
  assert.deepEqual(modelPricePresentation("openrouter", "audio"), {
    first: "INPUT RATE",
    second: "OUTPUT RATE",
    note: "Audio rates show whether billing uses tokens or input characters.",
  });
});
