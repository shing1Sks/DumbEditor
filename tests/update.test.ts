import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compareVersions, fetchTagVersion, installKind, readUpdateState, refreshUpdateState, runUpdate, updateChecksEnabled, updateNotice,
  type UpdateDeps,
} from "../src/platform/update.js";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "dumb-update-"));
  const packageRoot = join(root, "node_modules", "dumbeditor");
  await mkdir(packageRoot, { recursive: true });
  const lines: string[] = [];
  const ran: Array<[string, string[]]> = [];
  const requests: string[] = [];
  const deps = (over: Partial<UpdateDeps> & { registry?: string | number } = {}): UpdateDeps => {
    const registry = over.registry ?? "0.3.0";
    return {
      version: "0.2.0", packageRoot, platform: "linux", now: () => NOW, statePath: join(root, "update.json"),
      log: (line) => lines.push(line),
      run: async (command, args) => { ran.push([command, args]); return 0; },
      fetch: (async (url: string) => {
        requests.push(String(url));
        if (typeof registry === "number") return new Response("nope", { status: registry });
        return new Response(JSON.stringify({ version: registry }), { status: 200 });
      }) as typeof fetch,
      ...over,
    };
  };
  return { root, packageRoot, lines, ran, requests, deps, done: () => rm(root, { recursive: true, force: true }) };
}

test("versions compare by number, not by text, and a release beats its own pre-release", () => {
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.2.0", "0.3.0"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0-next.1"), 1);
  assert.equal(compareVersions("v0.2.1", "0.2.0"), 1);
});

test("the registry answer is only trusted when it is a real version, and failures give null", async () => {
  const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.equal(await fetchTagVersion("latest", reply({ version: "1.2.3" })), "1.2.3");
  assert.equal(await fetchTagVersion("latest", reply({ version: "1.2.3; rm -rf /" })), null);
  assert.equal(await fetchTagVersion("latest", reply({}, 200)), null);
  assert.equal(await fetchTagVersion("latest", reply({ version: "1.2.3" }, 404)), null);
  assert.equal(await fetchTagVersion("latest", (async () => { throw new Error("offline"); }) as unknown as typeof fetch), null);
});

test("update installs the newer version for the tag and remembers it", async () => {
  const box = await sandbox();
  try {
    assert.equal(await runUpdate([], box.deps()), 0);
    assert.deepEqual(box.ran, [["npm", ["install", "-g", "dumbeditor@latest"]]]);
    assert.match(box.requests[0]!, /registry\.npmjs\.org\/dumbeditor\/latest$/);
    assert.match(box.lines.join("\n"), /0\.2\.0 -> 0\.3\.0/);
    assert.deepEqual(await readUpdateState(join(box.root, "update.json")), { checkedAt: NOW, latest: "0.3.0", tag: "latest" });
  } finally { await box.done(); }
});

test("update does nothing when already on the newest version", async () => {
  const box = await sandbox();
  try {
    assert.equal(await runUpdate([], box.deps({ registry: "0.2.0" })), 0);
    assert.equal(box.ran.length, 0);
    assert.match(box.lines.join("\n"), /up to date/);
  } finally { await box.done(); }
});

test("--tag next follows the preview line, and the choice is kept for later checks", async () => {
  const box = await sandbox();
  try {
    assert.equal(await runUpdate(["--tag", "next"], box.deps({ registry: "0.4.0" })), 0);
    assert.deepEqual(box.ran[0], ["npm", ["install", "-g", "dumbeditor@next"]]);
    assert.equal((await readUpdateState(join(box.root, "update.json")))?.tag, "next");
    // a plain `update` afterwards stays on next
    assert.equal(await runUpdate([], box.deps({ version: "0.4.0", registry: "0.5.0" })), 0);
    assert.deepEqual(box.ran[1], ["npm", ["install", "-g", "dumbeditor@next"]]);
  } finally { await box.done(); }
});

test("a tag that could carry shell text, or a missing one, is refused before anything runs", async () => {
  const box = await sandbox();
  try {
    assert.equal(await runUpdate(["--tag", "next & calc"], box.deps()), 1);
    assert.equal(await runUpdate(["--tag"], box.deps()), 1);
    assert.equal(await runUpdate(["now"], box.deps()), 1);
    assert.equal(box.ran.length, 0);
    assert.equal(box.requests.length, 0);
  } finally { await box.done(); }
});

test("an unreachable registry and a failing npm are reported with the exit code and a manual command", async () => {
  const box = await sandbox();
  try {
    assert.equal(await runUpdate([], box.deps({ registry: 503 })), 1);
    assert.match(box.lines.join("\n"), /Could not reach the npm registry/);
    assert.equal(box.ran.length, 0);

    const failing = box.deps({ run: async () => 243 });
    assert.equal(await runUpdate([], failing), 243);
    assert.match(box.lines.join("\n"), /npm install -g dumbeditor@latest/);
    assert.equal(await readUpdateState(join(box.root, "update.json")), null, "a failed install is not remembered as done");
  } finally { await box.done(); }
});

test("a source checkout and an npx copy are not updated with npm", async () => {
  const box = await sandbox();
  try {
    await mkdir(join(box.packageRoot, ".git"));
    assert.equal(installKind(box.packageRoot), "source");
    assert.equal(await runUpdate([], box.deps()), 1);
    assert.match(box.lines.join("\n"), /git pull/);
    assert.equal(updateChecksEnabled({}, box.packageRoot), false);

    const npx = join(box.root, "_npx", "abc", "node_modules", "dumbeditor");
    await mkdir(npx, { recursive: true });
    assert.equal(installKind(npx), "npx");
    assert.equal(await runUpdate([], box.deps({ packageRoot: npx })), 0);
    assert.equal(box.ran.length, 0);
    assert.equal(box.requests.length, 0);
  } finally { await box.done(); }
});

test("the daily check asks the registry once, then uses what it saved", async () => {
  const box = await sandbox();
  try {
    const first = await refreshUpdateState(box.deps());
    assert.equal(first?.latest, "0.3.0");
    assert.equal(box.requests.length, 1);

    const sameDay = await refreshUpdateState(box.deps({ now: () => NOW + DAY - 1000 }));
    assert.equal(sameDay?.latest, "0.3.0");
    assert.equal(box.requests.length, 1, "no second request within a day");

    const nextDay = await refreshUpdateState(box.deps({ now: () => NOW + DAY + 1000, registry: "0.3.1" }));
    assert.equal(nextDay?.latest, "0.3.1");
    assert.equal(box.requests.length, 2);
  } finally { await box.done(); }
});

test("when the registry cannot be reached the check keeps the old answer and does not throw", async () => {
  const box = await sandbox();
  try {
    await writeFile(join(box.root, "update.json"), JSON.stringify({ checkedAt: NOW - 3 * DAY, latest: "0.3.0", tag: "latest" }));
    const state = await refreshUpdateState(box.deps({ registry: 500 }));
    assert.equal(state?.latest, "0.3.0");
    assert.equal(await refreshUpdateState(box.deps({ statePath: join(box.root, "missing", "x.json"), registry: 500 })), null);
    assert.equal(JSON.parse(await readFile(join(box.root, "update.json"), "utf8")).checkedAt, NOW - 3 * DAY, "the failed look is not recorded as a check");
  } finally { await box.done(); }
});

test("the notice appears only for a newer version and names the right command", () => {
  assert.equal(updateNotice("0.2.0", null), null);
  assert.equal(updateNotice("0.2.0", { checkedAt: NOW, latest: "0.2.0", tag: "latest" }), null);
  assert.equal(updateNotice("0.3.0", { checkedAt: NOW, latest: "0.2.0", tag: "latest" }), null);
  assert.match(updateNotice("0.2.0", { checkedAt: NOW, latest: "0.3.0", tag: "latest" }) ?? "", /0\.3\.0 is available.*dumbeditor update$/);
  assert.match(updateNotice("0.2.0", { checkedAt: NOW, latest: "0.3.0", tag: "next" }) ?? "", /dumbeditor update --tag next$/);
});

test("update checks can be switched off and never run in CI", async () => {
  const box = await sandbox();
  try {
    assert.equal(updateChecksEnabled({}, box.packageRoot), true);
    assert.equal(updateChecksEnabled({ DUMBEDITOR_NO_UPDATE_CHECK: "1" }, box.packageRoot), false);
    assert.equal(updateChecksEnabled({ CI: "true" }, box.packageRoot), false);
  } finally { await box.done(); }
});
