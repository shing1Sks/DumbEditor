import React from "react";
import { render } from "ink";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "./ui/App.js";
import { loadEnvironment, runSetup } from "./core/config.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvironment(packageRoot);

const args = process.argv.slice(2);
if (args[0] === "setup") {
  await runSetup().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  process.exit(process.exitCode ?? 0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`DumbEditor — zero-UX terminal video editor

Usage:
  dumbeditor [video]
  dumbeditor setup

Controls:
  Space          Play or pause
  Left / Right   Seek 5 seconds
  Up / Down      Preview volume
  [ / ]          Mark selection in / out

Commands:
  /open <path>       Open a video
  /version [all]     Show version history
  /revert <id>       Switch to a saved version
  /undo              Switch to the current version's parent
  /export <path>     Export the active version
  /status            Show project details
  /help              Show help in the editor
  /quit              Exit`);
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log("0.1.0");
  process.exit(0);
}

const initialPath = args.find((argument) => !argument.startsWith("-"));
process.title = "DumbEditor";
const useAlternateScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY);
let screenRestored = false;
const restoreScreen = () => {
  if (!useAlternateScreen || screenRestored) return;
  screenRestored = true;
  process.stdout.write("\u001B[0m\u001B[?25h\u001B[?1049l");
};

if (useAlternateScreen) process.stdout.write("\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l");
const app = render(<App {...(initialPath ? { initialPath } : {})} />, { exitOnCtrlC: false });
process.once("exit", restoreScreen);
try {
  await app.waitUntilExit();
} finally {
  app.unmount();
}
