import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Guards how DumbEditor is packaged. Windows has an FFmpeg with libass and must never download the 36 MB native
// canvas library, so that library may only reach users through the `dumbeditor-canvas` wrapper, which npm skips on
// Windows because of its `os` field.

function packageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate) && (JSON.parse(readFileSync(candidate, "utf8")) as { name?: string }).name === "dumbeditor") return directory;
    directory = dirname(directory);
  }
  throw new Error("package root not found");
}

const root = packageRoot();
const read = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown> & {
  version: string; os?: string[]; files?: string[];
  dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
};

test("the native canvas library reaches users only through the os-restricted wrapper", () => {
  const main = read("package.json");
  const wrapper = read("packages/dumbeditor-canvas/package.json");
  assert.equal(main.dependencies?.["@napi-rs/canvas"], undefined, "not a regular dependency");
  assert.equal(main.optionalDependencies?.["@napi-rs/canvas"], undefined, "not an optional dependency either: that would install it on Windows");
  assert.ok(main.devDependencies?.["@napi-rs/canvas"], "kept for types and for the tests on every platform");
  assert.deepEqual(wrapper.os, ["darwin", "linux"], "the wrapper is skipped on Windows");
  assert.equal(wrapper.dependencies?.["@napi-rs/canvas"], main.devDependencies?.["@napi-rs/canvas"], "same library version in both places");
});

test("the root package asks for a wrapper version the repository actually has", () => {
  const main = read("package.json");
  const wrapper = read("packages/dumbeditor-canvas/package.json");
  const range = main.optionalDependencies?.["dumbeditor-canvas"];
  assert.ok(range, "listed as an optional dependency");
  const wanted = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(range as string);
  const have = /^(\d+)\.(\d+)\.(\d+)$/.exec(wrapper.version);
  assert.ok(wanted && have, "plain versions");
  assert.equal(wanted[1], have[1], "same major");
  if (have[1] === "0") assert.equal(wanted[2], have[2], "same minor while the major is 0 (a caret range is that narrow)");
  assert.ok(Number(have[3]) >= Number(wanted[3]) || wanted[2] !== have[2], "not older than the range asks for");
});

test("the wrapper ships what it needs and the main package ships the fonts", () => {
  const wrapper = read("packages/dumbeditor-canvas/package.json");
  for (const file of wrapper.files ?? []) assert.ok(existsSync(join(root, "packages/dumbeditor-canvas", file)), file);
  assert.ok(read("package.json").files?.includes("assets"), "the bundled fonts are published");
  assert.ok(existsSync(join(root, "assets/fonts/OFL.txt")));
});
