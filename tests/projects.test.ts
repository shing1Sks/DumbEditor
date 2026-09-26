import assert from "node:assert/strict";
import test from "node:test";
import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectStore } from "../src/core/project.js";
import { runProcess } from "../src/core/process.js";

test("archives fresh sessions and discovers named projects", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-projects-"));
  const previousConfig = process.env.DUMBEDITOR_CONFIG_DIR;
  process.env.DUMBEDITOR_CONFIG_DIR = join(directory, "config");
  try {
    const source = join(directory, "demo.mp4");
    await runProcess("ffmpeg", [
      "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=160x90:duration=1",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
    ], { timeoutMs: 30_000 });

    const original = await ProjectStore.open(source);
    const name = await original.nameFromFirstRequest("Add a polished launch animation to this demo");
    assert.match(name, /^Add a polished launch animation to this demo · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const output = original.nextOutputPath();
    await copyFile(source, output);
    await original.commit({ outputPath: output, action: "Test edit", request: "test", duration: 1 });
    await original.register();

    const fresh = await ProjectStore.fresh(source);
    assert.equal(fresh.current.id, "v0000");
    assert.equal(fresh.snapshot.versions.length, 1);
    await fresh.register();

    const projects = await ProjectStore.listProjects(source);
    assert.equal(projects.length, 2);
    const archived = projects.find((project) => project.name === name);
    assert.ok(archived);
    assert.equal(archived.versionCount, 2);
    const reopened = await ProjectStore.openProject(archived.projectDir);
    assert.equal(reopened.current.id, "v0001");
    assert.equal(reopened.name, name);
    await access(reopened.current.filePath);

    await ProjectStore.clean(source);
    await access(archived.projectDir);
  } finally {
    if (previousConfig === undefined) delete process.env.DUMBEDITOR_CONFIG_DIR;
    else process.env.DUMBEDITOR_CONFIG_DIR = previousConfig;
    await rm(directory, { recursive: true, force: true });
  }
});
