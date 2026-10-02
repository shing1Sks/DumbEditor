// THROWAWAY SPIKE: interactive demo of the pi-tui shell with a live Sixel video layer.
// Run from the DumbEditor folder:  npx tsx "%TEMP%\pi-tui-spike\run.mts" "path\to\video.mp4"
import { spawn, type ChildProcess } from "node:child_process";
import { ProcessTerminal, matchesKey } from "@earendil-works/pi-tui";
import { createApp, LEFT_W, RIGHT_W } from "./app.mjs";
import { rgbToSixel } from "file:///C:/Users/SHREYASH%20KUMAR%20SINGH/Desktop/DumbEditor/src/core/media.ts";

const video = process.argv[2];
if (!video) { console.error("usage: run.mts <video file>"); process.exit(1); }
const CELL_W = Number(process.env.DUMBEDITOR_CELL_WIDTH ?? 10);
const CELL_H = Number(process.env.DUMBEDITOR_CELL_HEIGHT ?? 20);

let sixel: string | null = null;
let paused = false;
let ffmpeg: ChildProcess | null = null;
let size = { w: 0, h: 0 };
let app: ReturnType<typeof createApp>;

function startVideo(): void {
  ffmpeg?.kill();
  const r = app.rect();
  const maxW = Math.max(40, r.w * CELL_W), maxH = Math.max(40, r.h * CELL_H);
  const w = Math.floor(maxW / 2) * 2, h = Math.floor(maxH / 2) * 2;
  size = { w, h };
  const child = spawn("ffmpeg", ["-v", "error", "-stream_loop", "-1", "-re", "-i", video, "-vf", `fps=12,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  ffmpeg = child;
  const frameBytes = w * h * 3;
  let chunks: Buffer[] = [], have = 0;
  child.stdout!.on("data", (data: Buffer) => {
    chunks.push(data); have += data.length;
    while (have >= frameBytes) {
      const all = Buffer.concat(chunks);
      const frame = all.subarray(0, frameBytes);
      const rest = all.subarray(frameBytes);
      chunks = rest.length ? [Buffer.from(rest)] : []; have = rest.length;
      if (paused || child !== ffmpeg) continue;
      sixel = rgbToSixel(Buffer.from(frame), w, h);
      app.newVideoFrame();
    }
  });
}

const terminal = new ProcessTerminal();
app = createApp({ terminal, sixel: () => sixel });
const { tui, editor } = app;
let lastRect = "";
setInterval(() => { // restart decoding at the new size after a resize settles
  const r = app.rect(); const key = `${r.w}x${r.h}`;
  if (key !== lastRect) { lastRect = key; startVideo(); }
}, 400).unref();

let answering = false;
editor.onSubmit = (text: string) => {
  if (!text.trim()) return;
  app.say(`you: ${text}`);
  if (answering) return;
  answering = true;
  const words = "I am a fake agent answer streaming into the chat so you can watch the panels and video stay put while the transcript scrolls. ".repeat(3).split(" ");
  let line = "agent: ", i = 0;
  const node = { text: "" };
  const timer = setInterval(() => {
    line += `${words[i++]} `;
    if (line.length > 60 || i >= words.length) { app.say(line); line = "  "; }
    if (i >= words.length) { clearInterval(timer); answering = false; app.status.setText?.("status: ready"); }
  }, 60);
  void node;
};
app.say("pi-tui spike. Space: pause video | p: approval popup | Enter: send (fake streaming answer) | q or Ctrl+C: quit");
app.say("Try: paste a very long line, resize the window, scroll the chat with the mouse wheel.");

tui.addInputListener((data: string) => {
  if (matchesKey(data, "ctrl+c") || (data === "q" && editor.getText?.() === "")) { ffmpeg?.kill(); tui.stop(); process.exit(0); }
  if (data === " " && editor.getText?.() === "") { paused = !paused; app.status.setText?.(`status: ${paused ? "paused" : "playing"}`); tui.requestRender(); return { consume: true }; }
  if (data === "p" && editor.getText?.() === "") { app.state.overlay ? app.hidePopup() : app.showPopup(); return { consume: true }; }
  return undefined;
});
app.start();
void LEFT_W; void RIGHT_W; void size;
