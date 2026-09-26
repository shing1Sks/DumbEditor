import { useEffect, useState } from "react";
import { basename } from "node:path";
import { Box, Text } from "ink";
import type { AgentAsset } from "../core/agent-workspace.js";
import { formatUsd } from "../core/usage.js";
import { extractFrame, streamPreview } from "../core/media.js";
import { assetIcon } from "./Sidebars.js";

export function AssetPanel(props: { assets: AgentAsset[]; selectedIndex: number; playing: boolean; onPlaybackEnd: () => void; width: number; height: number }) {
  const selected = props.assets[props.selectedIndex];
  const listWidth = Math.max(26, Math.floor(props.width * 0.38));
  const room = Math.max(1, props.height - 5);
  const start = Math.min(Math.max(0, props.selectedIndex - room + 1), Math.max(0, props.assets.length - room));
  const visible = props.assets.slice(start, start + room);
  return (
    <Box width={props.width} height={props.height} borderStyle="single" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">Assets</Text>
        <Text dimColor>↑/↓ select · Space play · Shift+A/Esc close · type to chat</Text>
      </Box>
      {props.assets.length === 0 ? <Text dimColor>No project assets yet. Ask the editor agent to create an image, sound, video, or subtitles.</Text> : (
        <Box flexDirection="row" flexGrow={1}>
          <Box width={listWidth} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
            {visible.map((asset, offset) => {
              const index = start + offset;
              return <Text key={asset.id} inverse={index === props.selectedIndex} {...(index === props.selectedIndex ? { color: "cyan" as const } : {})} wrap="truncate-end">
                {index === props.selectedIndex ? "›" : " "} {assetIcon(asset.kind)} {asset.description} · {asset.costUsd === undefined ? "cost unavailable" : formatUsd(asset.costUsd, asset.costEstimated)}
              </Text>;
            })}
          </Box>
          <Box flexDirection="column" paddingLeft={2} width={Math.max(20, props.width - listWidth - 4)}>
            {selected && <>
              <Text bold>{assetIcon(selected.kind)} {selected.description}</Text>
              <Text dimColor>{basename(selected.path)}</Text>
              <Text>Type: {selected.kind}</Text>
              <Text>Source: {selected.source}</Text>
              <Text>Model: {selected.model ?? "local"}</Text>
              <Text>Cost: {selected.costUsd === undefined ? "unavailable" : formatUsd(selected.costUsd, selected.costEstimated)}</Text>
              {selected.license && <Text wrap="wrap">License: {selected.license}</Text>}
              {(selected.kind === "audio" || selected.kind === "music" || selected.kind === "video") &&
                <Text color={props.playing ? "green" : "cyan"}>{props.playing ? "▶ playing preview" : "Space plays this asset"}</Text>}
              {selected.kind === "image" && <Text color="cyan">Image saved and ready for the editor agent to place in the video.</Text>}
              {(selected.kind === "image" || selected.kind === "video") &&
                <VisualAssetPreview path={selected.path} video={selected.kind === "video"} playing={props.playing}
                  onPlaybackEnd={props.onPlaybackEnd}
                  width={Math.max(10, props.width - listWidth - 8)} height={Math.max(2, props.height - 11)} />}
              {selected.kind === "file" && <Text color="cyan">Subtitle or workspace file saved as a reusable asset.</Text>}
            </>}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function VisualAssetPreview(props: { path: string; video: boolean; playing: boolean; onPlaybackEnd: () => void; width: number; height: number }) {
  const [frame, setFrame] = useState<string>("");
  useEffect(() => {
    const controller = new AbortController();
    const width = Math.max(2, Math.floor(props.width / 2) * 2);
    const height = Math.max(2, Math.floor((props.height * 2) / 2) * 2);
    if (props.video && props.playing) {
      const preview = streamPreview({ filePath: props.path, start: 0, size: { width, height }, fps: 6,
        onFrame: setFrame, onEnd: props.onPlaybackEnd, onError: () => setFrame("Preview unavailable") });
      return () => { controller.abort(); preview.stop(); };
    }
    void extractFrame(props.path, 0, { width, height }, controller.signal).then(setFrame).catch(() => setFrame("Preview unavailable"));
    return () => controller.abort();
  }, [props.height, props.onPlaybackEnd, props.path, props.playing, props.video, props.width]);
  return <Text>{frame || "Loading preview…"}</Text>;
}
