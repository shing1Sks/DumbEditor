import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import {
  MUSIC_CATALOG,
  findMusicTrack,
  listMusicGenres,
  listMusicMoods,
  listMusicTracks,
  searchMusicTracks,
} from "../src/core/music-catalog.js";
import {
  MusicPreviewController,
  clearMusicSelection,
  musicPreviewArguments,
  readMusicSelection,
  selectMusicTrack,
  selectedMusicTrack,
  type MusicPreviewSpawner,
} from "../src/core/music.js";

test("catalog entries include remote assets and explicit open-license metadata", () => {
  assert.ok(MUSIC_CATALOG.length >= 4);
  for (const track of MUSIC_CATALOG) {
    assert.match(track.assetUrl, /^https:\/\//);
    assert.match(track.sourceUrl, /^https:\/\//);
    assert.equal(track.license.spdx, "CC-BY-4.0");
    assert.match(track.license.url, /^https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//);
    assert.match(track.license.attribution, new RegExp(track.title, "i"));
    assert.match(track.license.attribution, new RegExp(track.artist, "i"));
    assert.ok(track.isrc);
  }
});

test("lists, filters, searches, and resolves catalog tracks", () => {
  assert.deepEqual(searchMusicTracks("upbeat").map((track) => track.id), ["carefree"]);
  assert.deepEqual(searchMusicTracks("reflective synth").map((track) => track.id), ["sincerely"]);
  assert.deepEqual(listMusicTracks({ genre: "acoustic" }).map((track) => track.id), ["carefree", "clear-air"]);
  assert.equal(listMusicTracks({ limit: 2 }).length, 2);
  assert.equal(findMusicTrack("Clear Air")?.id, "clear-air");
  assert.ok(listMusicGenres().includes("electronica"));
  assert.ok(listMusicMoods().includes("uplifting"));
});

test("persists, restores, and clears the selected catalog track", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dumbeditor-music-"));
  const path = join(directory, "music-selection.json");
  try {
    assert.deepEqual(await readMusicSelection(path), { schemaVersion: 1, trackId: null, updatedAt: null });
    const selected = await selectMusicTrack("Clear Air", path);
    assert.equal(selected.trackId, "clear-air");
    assert.equal((await selectedMusicTrack(path))?.title, "Clear Air");
    assert.equal((await clearMusicSelection(path)).trackId, null);
    assert.equal(await selectedMusicTrack(path), null);
    await assert.rejects(selectMusicTrack("not-a-track", path), /was not found/);
    await writeFile(path, "not json", "utf8");
    await assert.rejects(readMusicSelection(path), /selection is invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("builds a bounded ffplay invocation for the trusted catalog URL", () => {
  const track = findMusicTrack("carefree")!;
  const args = musicPreviewArguments(track, { volume: 42, startSeconds: 10, durationSeconds: 15 });
  assert.deepEqual(args.slice(0, 5), ["-nostdin", "-nodisp", "-autoexit", "-loglevel", "error"]);
  assert.equal(args.at(-1), track.assetUrl);
  assert.ok(args.includes("42"));
  assert.ok(args.includes("15.000"));
  assert.throws(() => musicPreviewArguments(track, { volume: 101 }), /between 0 and 100/);
});

test("preview controller replaces, stops, and disposes one owned process", () => {
  const children: FakeProcess[] = [];
  const spawnedArgs: Array<readonly string[]> = [];
  const spawner: MusicPreviewSpawner = (_track, args) => {
    const child = new FakeProcess();
    children.push(child);
    spawnedArgs.push(args);
    return { process: child as unknown as ChildProcess, errorOutput: () => "preview failed" };
  };
  const controller = new MusicPreviewController(spawner);
  let ended = 0;
  let errors = 0;

  controller.play("carefree", { onEnd: () => { ended += 1; } });
  assert.equal(controller.activeTrack?.id, "carefree");
  controller.play("sincerely", { onError: () => { errors += 1; } });
  assert.equal(children[0]?.killed, true);
  assert.equal(controller.activeTrack?.id, "sincerely");
  assert.equal(spawnedArgs.length, 2);

  children[1]?.emit("close", 0, null);
  assert.equal(controller.activeTrack, null);
  assert.equal(ended, 0);
  assert.equal(errors, 0);

  controller.play("clear-air", { onEnd: () => { ended += 1; } });
  children[2]?.emit("close", 0, null);
  assert.equal(ended, 1);

  controller.play("eternity", { onError: () => { errors += 1; } });
  children[3]?.emit("close", 1, null);
  assert.equal(errors, 1);

  controller.play("carefree");
  controller.dispose();
  assert.equal(children[4]?.killed, true);
  assert.throws(() => controller.play("carefree"), /disposed/);
});

class FakeProcess extends EventEmitter {
  killed = false;

  kill(): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.emit("close", null, "SIGTERM");
    return true;
  }
}
