import assert from "node:assert/strict";
import test from "node:test";
import { copyFile } from "node:fs/promises";
import { summarizeUsage } from "../src/core/usage.js";
import { makeProject } from "./helpers/project.js";

test("pinned versions survive retention pruning; unpinned ones do not", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    await project.store.setVersionLimit(1);
    const commit = async () => {
      const output = project.store.nextOutputPath();
      await copyFile(project.store.snapshot.sourcePath, output);
      return project.store.commit({ outputPath: output, action: "copy", request: "test", duration: 4 });
    };
    const first = await commit();
    await project.store.pinVersion(first.id);
    await commit();
    await commit();
    const ids = project.store.snapshot.versions.map((version) => version.id);
    assert.ok(ids.includes("v0001"), "pinned version must be retained");
    assert.ok(!ids.includes("v0002"), "unpinned older version is pruned");
    assert.ok(ids.includes("v0003"), "the active version is retained");
  } finally {
    await project.cleanup();
  }
});

test("pinning keeps only the newest twenty versions and ignores unknown ids", { timeout: 90_000 }, async () => {
  const project = await makeProject();
  try {
    await project.store.pinVersion("v9999");
    assert.deepEqual([...project.store.pinnedVersionIds], []);
    await project.store.setVersionLimit(100);
    for (let index = 0; index < 22; index += 1) {
      const output = project.store.nextOutputPath();
      await copyFile(project.store.snapshot.sourcePath, output);
      const version = await project.store.commit({ outputPath: output, action: "copy", request: "test", duration: 4 });
      await project.store.pinVersion(version.id);
    }
    assert.equal(project.store.pinnedVersionIds.length, 20);
    assert.equal(project.store.pinnedVersionIds.at(-1), "v0022");
    assert.ok(!project.store.pinnedVersionIds.includes("v0001"));
  } finally {
    await project.cleanup();
  }
});

test("editor state bumps its revision only when the described text changes", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    const { state } = project;
    let notified = 0;
    state.subscribe(() => { notified += 1; });
    const start = state.revision;
    state.setPlayhead(1.04);
    assert.equal(state.revision, start + 1);
    state.setPlayhead(1.01);
    assert.equal(state.revision, start + 1, "a move inside the same tenth of a second changes nothing");
    state.setSelection({ in: 1, out: null });
    state.setSelection({ in: 1, out: null });
    assert.equal(state.revision, start + 2, "setting the same marks twice changes nothing");
    state.setPlayhead(99);
    assert.equal(state.playhead, state.media.duration, "the playhead is clamped to the video");
    assert.ok(notified >= 3);
    const described = state.describe();
    assert.equal(described.revision, state.revision);
    assert.match(described.body, /In mark: 1\.0s/);
  } finally {
    await project.cleanup();
  }
});

test("recorded usage reaches the in-memory summary and the saved ledger, counting agent cost with the editor model", { timeout: 60_000 }, async () => {
  const project = await makeProject();
  try {
    await project.state.recordUsage({ kind: "agent", provider: "openrouter", model: "m", label: "turn", costUsd: 0.25, estimated: false });
    await project.state.recordUsage({ kind: "asset", provider: "openrouter", model: "m", label: "image", costUsd: 0.5, estimated: true });
    assert.deepEqual(project.state.usage, { totalUsd: 0.75, lunaUsd: 0.25, assetUsd: 0.5, harnessUsd: 0, entries: 2 });
    assert.deepEqual(summarizeUsage(await project.store.usageEntries()), project.state.usage);
  } finally {
    await project.cleanup();
  }
});
