import React from "react";
import { render } from "ink";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment, runSetup } from "./core/config.js";
import { ProjectStore } from "./core/project.js";
import { markWelcomeShown } from "./core/settings.js";
import { App } from "./ui/App.js";
import { createLayeredStdout } from "./ui/terminal-layers.js";

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

let launchArgs = args;
if (args[0] === "--fresh") {
  const source = args[1];
  if (!source || args.length !== 2) {
    console.error("Usage: dumbeditor --fresh <video>");
    process.exit(1);
  }
  await ProjectStore.clean(source).catch((error: unknown) => {
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
  process.exit(0);
}

const initialPath = launchArgs[0]!;
process.title = "DumbEditor";
const useAlternateScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY);
let screenRestored = false;
const restoreScreen = () => {
  if (!useAlternateScreen || screenRestored) return;
  screenRestored = true;
  process.stdout.write("\u001B[0m\u001B[?25h\u001B[?1049l");
};

if (useAlternateScreen) process.stdout.write("\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l");
const app = render(<App initialPath={initialPath} />, {
  exitOnCtrlC: false,
  stdout: createLayeredStdout(process.stdout),
});
process.once("exit", restoreScreen);
try {
  await app.waitUntilExit();
} finally {
  app.unmount();
}

function overviewMessage(installedVersion: string): string {
  return `DumbEditor ${installedVersion}
Agent-first video editing in your terminal.

Describe an edit in plain language or use a direct slash command. Every edit is
versioned, reversible, and rendered locally with FFmpeg.

Start:
  dumbeditor setup
  dumbeditor <video>

Learn more:
  dumbeditor --help`;
}

function firstLaunchMessage(installedVersion: string): string {
  return `Hello from DumbEditor ${installedVersion}.

Simple video edits should not require a wall of buttons, tutorials, or a pile of
AI credits spent learning an interface. DumbEditor is an agent-first editor: tell
it what to change, preview the result in your terminal, and keep every edit
reversible.

1. Run:  dumbeditor setup  (keys + one-time local agent sandbox)
2. Open: dumbeditor <video>
3. Type a request, or type / to discover direct commands.

Run dumbeditor --help for the complete reference.`;
}

function helpMessage(installedVersion: string): string {
  return `DumbEditor ${installedVersion} - agent-first video editing in your terminal

Usage:
  dumbeditor <video>    Open a video in the editor
  dumbeditor            Show the project overview and next steps
  dumbeditor setup      Configure provider keys and the local agent sandbox
  dumbeditor clean <video> Remove saved project state; preserve the source
  dumbeditor --fresh <video> Clean the project and open the source immediately
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
  Esc            Minimize chat, close a panel, or clear the input
  Ctrl+C         Quit
  Shift+A        Open or close the project asset browser

Editor commands:
  /clip-remove <FROM> <TO> [FROM TO ...]
  /clip-keep <FROM> <TO>
  /speed <FROM> <TO> <FACTOR>
  /mute <FROM> <TO>
  /crop <WIDTH>x<HEIGHT> [X,Y]
  /open <path>       Open a video
  /version [all]     Show version history
  /version-limits [N] Show or set retained edit versions (default: 5)
  /revert <id>       Switch to a saved version
  /undo              Switch to the current version's parent
  /export [path]     Choose destination, MP4/MKV, and compression
  /model             Choose a provider, capability, and model interactively
  /bg-music [query]  Search, preview, and select open-license music
  /assets            Browse generated and project assets
  /permissions [mode] Show or set ask/auto approval mode
  /harness-model [id] Show or set the optional Claude harness model
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
