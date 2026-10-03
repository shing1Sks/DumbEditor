import { ProcessTerminal } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment, runSetup } from "./core/config.js";
import { ProjectStore } from "./core/project.js";
import { markWelcomeShown } from "./core/settings.js";
import { defaultUpdateDeps, refreshUpdateState, runUpdate, updateChecksEnabled, updateNotice } from "./platform/update.js";
import { ShellApp } from "./shell/app.js";
import { setMeasuredCell } from "./shell/preview/painters/cell-size.js";
import { detectPainter } from "./shell/preview/painters/detect.js";
import { kittyKeepsImages, setKittyPersistent } from "./shell/preview/painters/kitty.js";
import { probeStdio } from "./shell/preview/painters/probe.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvironment(packageRoot);
const packageInfo = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as { version?: string };
const version = packageInfo.version ?? "0.0.0";
const args = process.argv.slice(2);

if (args[0] === "setup") {
  await runSetup().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  process.exit(process.exitCode ?? 0);
}

if (args[0] === "update") {
  process.exit(await runUpdate(args.slice(1), defaultUpdateDeps(version, packageRoot)));
}

if (args[0] === "doctor") {
  const { runDoctor } = await import("./platform/doctor.js");
  process.exit(await runDoctor());
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(helpMessage(version));
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

if (args[0] === "clean") {
  const source = args[1];
  if (!source || args.length !== 2) {
    console.error("Usage: dumbeditor clean <video>");
    process.exit(1);
  }
  const removed = await ProjectStore.clean(source).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return null;
  });
  if (removed) console.log(`Cleaned DumbEditor project state for ${resolve(source)}\nSource video preserved.`);
  process.exit(process.exitCode ?? 0);
}

const updateDeps = defaultUpdateDeps(version, packageRoot);
const checksEnabled = updateChecksEnabled(process.env, packageRoot);
let launchArgs = args;
if (args[0] === "--fresh") {
  const source = args[1];
  if (!source || args.length !== 2) {
    console.error("Usage: dumbeditor --fresh <video>");
    process.exit(1);
  }
  await ProjectStore.fresh(source).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
  launchArgs = [source];
}

const unknownOption = launchArgs.find((argument) => argument.startsWith("-"));
if (unknownOption) {
  console.error(`Unknown option: ${unknownOption}\nRun dumbeditor --help for usage.`);
  process.exit(1);
}

if (launchArgs.length === 0) {
  const firstLaunch = await markWelcomeShown().catch(() => false);
  console.log(firstLaunch ? firstLaunchMessage(version) : overviewMessage(version));
  const notice = checksEnabled ? updateNotice(version, await refreshUpdateState(updateDeps).catch(() => null)) : null;
  if (notice) console.log(`
${notice}`);
  process.exit(0);
}

const initialPath = launchArgs[0]!;
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("DumbEditor needs an interactive terminal. Run it from a terminal window.");
  process.exit(1);
}
process.title = "DumbEditor";
// Look for a newer version in the background (at most once a day); the answer is shown after the editor closes.
const updateCheck = checksEnabled ? refreshUpdateState(updateDeps).catch(() => null) : Promise.resolve(null);
// Ask the terminal what picture it can show before the screen starts (never on Windows, in tmux, or in Terminal.app).
const detected = await detectPainter({ env: process.env, platform: process.platform, isTTY: true, probe: () => probeStdio(process.env) });
if (detected.probed?.cell) setMeasuredCell(detected.probed.cell);
setKittyPersistent(kittyKeepsImages(detected.probed?.name, process.env));
const terminal = new ProcessTerminal();
const exitCode = await new Promise<number>((done) => {
  const app = new ShellApp({ terminal, initialPath, backend: detected.id, onExit: done });
  process.once("exit", () => app.dispose());
  // Closing the terminal tab sends SIGHUP and `kill` sends SIGTERM; neither runs "exit" handlers,
  // so stop child processes and give the terminal back before leaving.
  for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => { app.dispose(); done(code); });
  }
  // A crash must give the terminal back before it prints the error, or the message is lost in the alternate screen.
  for (const event of ["uncaughtException", "unhandledRejection"] as const) {
    process.once(event, (error: unknown) => {
      app.dispose();
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      done(1);
    });
  }
  app.start().catch((error: unknown) => {
    app.dispose();
    console.error(error instanceof Error ? error.message : String(error));
    done(1);
  });
});
await terminal.drainInput(200, 30);
const notice = updateNotice(version, await Promise.race([updateCheck, new Promise<null>((done) => setTimeout(() => done(null), 300).unref())]));
if (notice) console.log(`
${notice}`);
process.exit(exitCode);

function overviewMessage(installedVersion: string): string {
  return `DumbEditor ${installedVersion}
The video editor in the DUMB tools family.

DUMB means Direct Unbounded Media Builder: minimal, open source, agent-first
software that turns intent into finished work without a complex app in between.

Describe an edit in plain language or use a direct slash command. Every edit is
versioned, reversible, and rendered locally with FFmpeg.

Start:
  dumbeditor setup
  dumbeditor doctor
  dumbeditor update
  dumbeditor <video>

Learn more:
  dumbeditor --help`;
}

function firstLaunchMessage(installedVersion: string): string {
  return `Hello from DumbEditor ${installedVersion}.

DUMB means Direct Unbounded Media Builder. It is a family of minimal, open source,
agent-first tools built around what you want to make.

DumbEditor is the first one. Tell it what to change, preview the result in your
terminal, and keep every edit reversible. No wall of buttons. No tutorial before
the first cut. No separate subscription for every step.

1. Run:  dumbeditor setup  (keys + one-time local agent sandbox)
2. Open: dumbeditor <video>
3. Type a request, or type / to discover direct commands.

Run dumbeditor --help for the complete reference.`;
}

function helpMessage(installedVersion: string): string {
  return `DumbEditor ${installedVersion} - Direct Unbounded Media Builder for video

Usage:
  dumbeditor <video>    Open a video in the editor
  dumbeditor            Show the project overview and next steps
  dumbeditor setup      Configure provider keys and the local agent sandbox
  dumbeditor doctor     Check FFmpeg, text support and the terminal picture
  dumbeditor update     Install the newest version (add --tag next for previews)
  dumbeditor clean <video> Permanently remove saved project state; preserve the source
  dumbeditor --fresh <video> Archive the current project and start a clean session
  dumbeditor --help     Show this complete reference
  dumbeditor --version  Print the installed version

Controls:
  Ctrl+P         Play or pause
  Left / Right   Seek 5 seconds
  Up / Down      Scroll chat, navigate suggestions, or move in multiline input
  PageUp/PageDown Scroll chat by a page
  + / -          Raise or lower preview volume
  Ctrl+G         Expand or minimize conversation focus
  [ / ]          Mark selection in / out
  Tab            Complete the selected slash command
  Enter          Send a request or complete a slash command
  Esc            Stop the agent, minimize chat, close a panel, or clear the input
  Ctrl+C         Stop the agent while it works; otherwise quit
  Ctrl+O         Open or close the project asset browser

Editor commands:
  /clip-remove <FROM> <TO> [FROM TO ...]
  /clip-keep <FROM> <TO>
  /speed <FROM> <TO> <FACTOR>
  /mute <FROM> <TO>
  /crop <WIDTH>x<HEIGHT> [X,Y]
  /open <path>       Open a video
  /projects          Browse and reopen saved projects
  /version [all]     Show version history
  /version-limits [N] Show or set retained edit versions (default: 5)
  /revert <id>       Switch to a saved version
  /undo              Switch to the current version's parent
  /export [path]     Choose destination, MP4/MKV, and compression
  /model             Choose a provider, capability, and model interactively
  /bg-music [query]  Search, preview, and select open-license music
  /assets            Browse generated and project assets
  /permissions [mode] Show or set ask/auto approval mode
  /budget [USD]       Show or set the per-run spend limit (0 turns it off)
  /compact            Summarize earlier conversation to free context
  /status            Show project details
  /play              Play the preview
  /pause             Pause the preview
  /clear             Clear visible chat
  /chat              Expand or minimize conversation focus
  /help              Show help in the editor
  /quit              Exit

Times:
  Seconds, mm:ss, hh:mm:ss, start, end, playhead, in, or out

Examples:
  dumbeditor "C:\\Videos\\demo.mp4"
  /clip-remove 0 2.5
  /speed in out 2x
  remove the first two seconds and mute the last five`;
}
