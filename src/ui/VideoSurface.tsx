import React, { useEffect, useMemo, useRef } from "react";
import { Box, Text } from "ink";
import type { MediaInfo, Selection } from "../types.js";
import {
  detectPreviewBackend,
  encodePreviewFrame,
  extractRawFrame,
  previewRenderSize,
  streamRawPreview,
  type PreviewBackend,
} from "../core/media.js";
import { formatTime } from "../core/time.js";
import { clearRetainedTerminalLayer, retainTerminalLayer, writeTerminalLayer } from "./terminal-layers.js";

interface PendingFrame {
  buffer: Buffer;
  time: number;
}

export const VideoSurface = React.memo(function VideoSurface(props: {
  filePath?: string;
  media: MediaInfo | null;
  playing: boolean;
  time: number;
  columns: number;
  rows: number;
  topRow?: number;
  leftColumn?: number;
  timelineColumns?: number;
  timelineLeftColumn?: number;
  repaintKey?: number;
  selection: Selection;
  onTime: (time: number, force: boolean) => void;
  onEnd: () => void;
  onError: (error: Error) => void;
}) {
  const backend = useMemo(() => detectPreviewBackend(), []);
  const size = useMemo(
    () => props.media
      ? previewRenderSize(props.media, props.columns, props.rows, backend)
      : { width: 0, height: 0 },
    [backend, props.columns, props.media, props.rows],
  );
  const layoutRef = useRef({
    backend,
    columns: props.columns,
    rows: props.rows,
    size,
    topRow: props.topRow ?? 2,
    leftColumn: props.leftColumn ?? 1,
  });
  layoutRef.current = { backend, columns: props.columns, rows: props.rows, size, topRow: props.topRow ?? 2, leftColumn: props.leftColumn ?? 1 };
  const lastFrame = useRef("");
  const imageLayer = useRef("");
  const timelineLayer = useRef("");
  const lastTime = useRef(props.time);
  const lastTimelinePaint = useRef(0);
  const timelineRef = useRef({
    columns: props.timelineColumns ?? props.columns,
    leftColumn: props.timelineLeftColumn ?? props.leftColumn ?? 1,
    duration: props.media?.duration ?? 0,
    row: (props.topRow ?? 2) + props.rows,
    selection: props.selection,
  });
  timelineRef.current = {
    columns: props.timelineColumns ?? props.columns,
    leftColumn: props.timelineLeftColumn ?? props.leftColumn ?? 1,
    duration: props.media?.duration ?? 0,
    row: (props.topRow ?? 2) + props.rows,
    selection: props.selection,
  };
  const pendingFrame = useRef<PendingFrame | null>(null);
  const drawing = useRef(false);
  const mounted = useRef(true);

  const commitLayers = () => {
    const output = `${imageLayer.current}${timelineLayer.current}`;
    retainTerminalLayer(output);
    writeTerminalLayer(output);
  };

  const stageEncoded = (encoded: string) => {
    if (!mounted.current || !encoded) return;
    const layout = layoutRef.current;
    const cellWidth = positiveInteger(process.env.DUMBEDITOR_CELL_WIDTH, 10);
    const imageColumns = layout.backend === "sixel"
      ? Math.ceil(layout.size.width / cellWidth)
      : layout.size.width;
    const column = layout.leftColumn + Math.max(0, Math.floor((layout.columns - imageColumns) / 2));
    let output = "\u001B7\u001B[?25l";
    if (layout.backend === "sixel") {
      output += `\u001B[${layout.topRow};${column}H${encoded}`;
    } else {
      const lines = encoded.split("\n").slice(0, layout.rows);
      for (let index = 0; index < lines.length; index += 1) {
        output += `\u001B[${layout.topRow + index};${column}H${lines[index]}`;
      }
    }
    output += "\u001B8";
    imageLayer.current = output;
  };

  const queueFrame = (buffer: Buffer, time: number) => {
    pendingFrame.current = { buffer, time };
    if (drawing.current) return;
    drawing.current = true;
    setImmediate(function flushLatestFrame() {
      if (!mounted.current) {
        drawing.current = false;
        return;
      }
      const pending = pendingFrame.current;
      pendingFrame.current = null;
      if (pending) {
        const layout = layoutRef.current;
        try {
          const encoded = encodePreviewFrame(pending.buffer, layout.size, layout.backend);
          lastFrame.current = encoded;
          lastTime.current = pending.time;
          stageEncoded(encoded);
          props.onTime(pending.time, false);
          if (pending.time - lastTimelinePaint.current >= 0.1 || pending.time < lastTimelinePaint.current) {
            lastTimelinePaint.current = pending.time;
            timelineLayer.current = timelineOutput(timelineRef.current, pending.time);
          }
          commitLayers();
        } catch (error) {
          props.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (pendingFrame.current) setImmediate(flushLatestFrame);
      else drawing.current = false;
    });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearRetainedTerminalLayer();
    };
  }, []);

  useEffect(() => {
    clearSurface(layoutRef.current.topRow, layoutRef.current.rows, layoutRef.current.leftColumn, layoutRef.current.columns);
    lastFrame.current = "";
    imageLayer.current = "";
    timelineLayer.current = "";
    clearRetainedTerminalLayer();
  }, [backend, props.columns, props.leftColumn, props.rows, size.height, size.width]);

  useEffect(() => {
    if (!props.filePath || !props.media || size.width === 0 || size.height === 0) return;
    let stopped = false;
    if (!props.playing) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        void extractRawFrame(props.filePath!, props.time, size, controller.signal)
          .then((frame) => { if (!stopped) queueFrame(frame, props.time); })
          .catch((error) => {
            if (!stopped && !controller.signal.aborted) props.onError(error instanceof Error ? error : new Error(String(error)));
          });
      }, 40);
      return () => {
        stopped = true;
        clearTimeout(timer);
        controller.abort();
      };
    }

    const start = props.time >= props.media.duration - 0.05 ? 0 : props.time;
    const preview = streamRawPreview({
      filePath: props.filePath,
      start,
      size,
      fps: backend === "sixel" ? 12 : 10,
      onFrame: (frame, time) => { if (!stopped) queueFrame(frame, Math.min(time, props.media!.duration)); },
      onEnd: () => {
        if (!stopped) {
          props.onTime(Math.min(props.media!.duration, start + props.media!.duration), true);
          props.onEnd();
        }
      },
      onError: (error) => { if (!stopped) props.onError(error); },
    });
    return () => {
      stopped = true;
      preview.stop();
    };
  }, [backend, props.filePath, props.media, props.playing, props.playing ? null : props.time, size.height, size.width]);

  // Windows Terminal can discard Sixel graphics when a tab regains focus.
  // Focus reporting in App increments this key so the retained frame is restored
  // without extracting it again or repainting the React layout.
  useEffect(() => {
    if (!lastFrame.current) return;
    stageEncoded(lastFrame.current);
    timelineLayer.current = timelineOutput(timelineRef.current, lastTime.current);
    commitLayers();
  }, [props.repaintKey]);

  return (
    <Box width={props.columns} height={props.rows} minHeight={props.rows} flexShrink={0} justifyContent="center" alignItems="center">
      {!props.filePath && <Text dimColor>No video loaded</Text>}
    </Box>
  );
});

export function activePreviewBackend(): PreviewBackend {
  return detectPreviewBackend();
}

function clearSurface(topRow: number, rows: number, leftColumn: number, columns: number): void {
  let output = "\u001B7";
  const blank = " ".repeat(Math.max(0, columns));
  for (let index = 0; index < rows; index += 1) output += `\u001B[${topRow + index};${leftColumn}H${blank}`;
  output += "\u001B8";
  writeTerminalLayer(output);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function timelineOutput(
  layout: { columns: number; leftColumn: number; duration: number; row: number; selection: Selection },
  current: number,
): string {
  if (layout.duration <= 0) return "";
  const length = Math.max(18, Math.min(90, layout.columns - 24));
  const cursor = timelinePosition(current, layout.duration, length);
  const inPoint = layout.selection.in === null ? -1 : timelinePosition(layout.selection.in, layout.duration, length);
  const outPoint = layout.selection.out === null ? -1 : timelinePosition(layout.selection.out, layout.duration, length);
  let bar = "";
  for (let index = 0; index < length; index += 1) {
    if (index === cursor) bar += "◆";
    else if (index === inPoint) bar += "╞";
    else if (index === outPoint) bar += "╡";
    else if (index < cursor) bar += "━";
    else bar += "─";
  }
  const plainWidth = formatTime(current).length + bar.length + formatTime(layout.duration).length + 2;
  const column = layout.leftColumn + Math.max(0, Math.floor((layout.columns - plainWidth) / 2));
  const line = `\u001B[36m${formatTime(current)}\u001B[0m ${bar} \u001B[90m${formatTime(layout.duration)}\u001B[0m`;
  return `\u001B7\u001B[${layout.row};${layout.leftColumn}H${" ".repeat(layout.columns)}\u001B[${layout.row};${column}H${line}\u001B8`;
}

function timelinePosition(value: number, duration: number, width: number): number {
  return Math.max(0, Math.min(width - 1, Math.round((value / duration) * (width - 1))));
}
