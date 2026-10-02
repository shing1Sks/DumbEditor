import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../../src/core/process.js";
import { ProjectStore } from "../../src/core/project.js";
import { EditorState } from "../../src/core/state/editor-state.js";

export interface TestProject {
  directory: string;
  store: ProjectStore;
  state: EditorState;
  cleanup(): Promise<void>;
}

/** A real 4 second 320x180 video with audio, opened as a project in a temp directory. */
export async function makeProject(): Promise<TestProject> {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-core-"));
  const previousConfig = process.env.DUMBEDITOR_CONFIG_DIR;
  process.env.DUMBEDITOR_CONFIG_DIR = join(directory, "config");
  const source = join(directory, "source.mp4");
  await runProcess("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
  ], { timeoutMs: 60_000 });
  const store = await ProjectStore.open(source);
  const state = await EditorState.open(store);
  return {
    directory, store, state,
    async cleanup() {
      if (previousConfig === undefined) delete process.env.DUMBEDITOR_CONFIG_DIR;
      else process.env.DUMBEDITOR_CONFIG_DIR = previousConfig;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
