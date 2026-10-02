import assert from "node:assert/strict";
import test from "node:test";
import { createEditorRegistry, directEditCall } from "../src/core/actions/index.js";
import { parseEditCommand } from "../src/core/commands.js";
import { actionContext } from "./helpers/actions.js";
import { makeProject } from "./helpers/project.js";

const EXPECTED_ACTIONS = [
  "add_background_music", "add_fade", "add_image_overlay", "add_text_overlay", "apply_visual_effect", "burn_subtitles",
  "change_speed", "compare_frames", "crop_video", "generate_asset", "get_editor_state", "inspect_video_frames",
  "keep_range", "list_assets", "list_versions", "list_workspace_files", "mute_range", "present_choices",
  "read_skill", "read_workspace_file", "register_workspace_asset", "remove_ranges", "render_custom_ffmpeg", "revert_to",
  "run_sandbox_script", "sandbox_status", "search_music_catalog", "search_project_chat", "transcribe_and_add_subtitles",
  "transcribe_video_audio", "write_workspace_file",
];

test("registers every editor action exactly once, with strict schemas", () => {
  const registry = createEditorRegistry();
  assert.deepEqual(registry.list().map((action) => action.name).sort(), EXPECTED_ACTIONS);
  for (const action of registry.list()) {
    const schema = action.schema as { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    assert.equal(schema.type, "object", action.name);
    assert.equal(schema.additionalProperties, false, action.name);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${action.name} must require every property`);
  }
});

test("classifies risk: paid generation and custom code ask, read-only actions never do", () => {
  const registry = createEditorRegistry();
  assert.equal(registry.riskOf("generate_asset", {}), "spend");
  assert.equal(registry.riskOf("render_custom_ffmpeg", {}), "code");
  assert.equal(registry.riskOf("run_sandbox_script", {}), "code");
  assert.equal(registry.riskOf("remove_ranges", {}), "edit");
  assert.equal(registry.riskOf("inspect_video_frames", {}), "read");
  assert.equal(registry.riskOf("transcribe_video_audio", {}), "read");
  assert.equal(registry.riskOf("transcribe_video_audio", { model: "gpt-4o-transcribe-diarize" }), "spend");
  assert.equal(registry.riskOf("transcribe_and_add_subtitles", { provider_options_json: "{\"a\":1}" }), "spend");
});

test("slash commands and agent tools call the same action with the same arguments", () => {
  const context = { duration: 4, currentTime: 0, selection: { in: null, out: null } };
  const parsed = (line: string) => {
    const edit = parseEditCommand(line, context);
    assert.ok(edit);
    return directEditCall(edit);
  };
  assert.deepEqual(parsed("/clip-remove 1 2"), { name: "remove_ranges", args: { ranges: [{ start: 1, end: 2 }] } });
  assert.deepEqual(parsed("/clip-keep 0.5 2.5"), { name: "keep_range", args: { start: 0.5, end: 2.5 } });
  assert.deepEqual(parsed("/speed 1 2 2x"), { name: "change_speed", args: { start: 1, end: 2, factor: 2 } });
  assert.deepEqual(parsed("/mute 1 2"), { name: "mute_range", args: { start: 1, end: 2 } });
  assert.deepEqual(parsed("/crop 160x90"), { name: "crop_video", args: { width: 160, height: 90, x: null, y: null } });
  const registry = createEditorRegistry();
  for (const line of ["/clip-remove 1 2", "/clip-keep 0.5 2.5", "/speed 1 2 2x", "/mute 1 2", "/crop 160x90"]) {
    const { name } = parsed(line);
    assert.ok(registry.get(name), `${name} must be a registered action`);
  }
});

test("an edit action commits a version, pins it, resets the playhead and updates the state description", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    const registry = createEditorRegistry();
    project.state.setPlayhead(2.5);
    project.state.setSelection({ in: 1, out: 2 });
    const before = project.state.revision;
    const result = await registry.run("remove_ranges", { ranges: [{ start: 3, end: 4 }] }, actionContext(project.state));
    assert.equal(result.versionId, "v0001");
    assert.ok(project.state.media.duration > 2.8 && project.state.media.duration < 3.2);
    assert.ok(project.state.revision > before);
    assert.equal(project.state.playhead, 0);
    assert.deepEqual(project.state.selection, { in: null, out: null });
    assert.deepEqual([...project.store.pinnedVersionIds], ["v0001"]);
    const described = project.state.describe().body;
    assert.match(described, /Active version: v0001 \(parent v0000\)/);
    assert.match(described, /Playhead: 0\.0s/);
  } finally {
    await project.cleanup();
  }
});

test("get_editor_state reports the playhead and marks the user set", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    project.state.setPlayhead(1.5);
    project.state.setSelection({ in: 1, out: null });
    const result = await createEditorRegistry().run("get_editor_state", {}, actionContext(project.state));
    assert.match(result.text, /Playhead: 1\.5s/);
    assert.match(result.text, /In mark: 1\.0s/);
    assert.match(result.text, /Out mark: unset/);
  } finally {
    await project.cleanup();
  }
});

test("revert_to and list_versions share the version store with the slash commands", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    const registry = createEditorRegistry();
    const context = actionContext(project.state);
    await registry.run("keep_range", { start: 0, end: 2 }, context);
    const reverted = await registry.run("revert_to", { version: "0" }, context);
    assert.equal(reverted.versionId, "v0000");
    assert.equal(project.store.current.id, "v0000");
    const listed = await registry.run("list_versions", {}, context);
    const rows = (listed.data as { versions: Array<{ id: string; active: boolean }> }).versions;
    assert.deepEqual(rows.map((row) => [row.id, row.active]), [["v0000", true], ["v0001", false]]);
    await assert.rejects(registry.run("revert_to", { version: "v9999" }, context), /not found/);
  } finally {
    await project.cleanup();
  }
});

test("an aborted action commits nothing", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(createEditorRegistry().run("remove_ranges", { ranges: [{ start: 1, end: 2 }] }, actionContext(project.state, controller.signal)));
    assert.equal(project.store.snapshot.versions.length, 1);
    assert.equal(project.store.current.id, "v0000");
  } finally {
    await project.cleanup();
  }
});

test("inspect_video_frames returns images and counts as an audit; compare_frames pairs two versions", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    const registry = createEditorRegistry();
    const context = actionContext(project.state);
    const inspected = await registry.run("inspect_video_frames", { timestamps: [0.5, 1.5], detail: "low" }, context);
    assert.equal(inspected.images?.length, 2);
    assert.equal(inspected.images?.[0]?.mimeType, "image/jpeg");
    assert.equal(registry.get("inspect_video_frames")?.audits, true);
    await registry.run("keep_range", { start: 0, end: 2 }, context);
    const compared = await registry.run("compare_frames", { version_a: "v0000", version_b: "v0001", timestamps: [0.5] }, context);
    assert.equal(compared.images?.length, 1);
    assert.match(compared.text, /v0000 \(left\) vs v0001 \(right\)/);
  } finally {
    await project.cleanup();
  }
});
