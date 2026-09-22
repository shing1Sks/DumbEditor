import type { DirectEdit, Route, Selection } from "../types.js";
import { extractRanges, parseCrop, parseSpeedFactor } from "./time.js";

export function parseDirectEdit(options: {
  route: Route;
  request: string;
  duration: number;
  currentTime: number;
  selection: Selection;
}): DirectEdit {
  const { route, request, duration, currentTime, selection } = options;
  if (route === "crop") {
    const crop = parseCrop(request);
    if (!crop) throw new Error("Add a crop size, for example: crop to 1280x720");
    return { action: "crop", ...crop };
  }
  if (route === "agent" || route === "explain") throw new Error(`${route} is not a direct edit`);
  const ranges = extractRanges(request, duration, currentTime, selection);
  if (ranges.length === 0) {
    throw new Error("Add a range such as “from 00:10 to 00:18”, or mark one with [ and ].");
  }
  if (route === "remove") return { action: "remove", ranges };
  if (ranges.length > 1) throw new Error(`${route} accepts one range at a time`);
  const range = ranges[0];
  if (!range) throw new Error("No usable time range was found");
  if (route === "trim") return { action: "trim", range };
  if (route === "mute") return { action: "mute", range };
  return { action: "speed", range, factor: parseSpeedFactor(request) };
}
