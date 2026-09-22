import React from "react";
import { Text } from "ink";
import type { Selection } from "../types.js";
import { formatTime } from "../core/time.js";

export function Timeline({ current, duration, selection, width }: {
  current: number;
  duration: number;
  selection: Selection;
  width: number;
}) {
  const length = Math.max(18, Math.min(90, width - 24));
  const cursor = position(current, duration, length);
  const inPoint = selection.in === null ? -1 : position(selection.in, duration, length);
  const outPoint = selection.out === null ? -1 : position(selection.out, duration, length);
  let bar = "";
  for (let index = 0; index < length; index += 1) {
    if (index === cursor) bar += "◆";
    else if (index === inPoint) bar += "╞";
    else if (index === outPoint) bar += "╡";
    else if (index < cursor) bar += "━";
    else bar += "─";
  }
  return (
    <Text>
      <Text color="cyan">{formatTime(current)}</Text>{" "}
      <Text color="gray">{bar}</Text>{" "}
      <Text color="gray">{formatTime(duration)}</Text>
    </Text>
  );
}

function position(value: number, duration: number, width: number): number {
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(width - 1, Math.round((value / duration) * (width - 1))));
}
