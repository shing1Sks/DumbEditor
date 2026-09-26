import React from "react";
import { Box, Text } from "ink";

export function Help() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">DumbEditor controls</Text>
      <Text>Space play/pause  ←/→ seek 5s  ↑/↓ volume  [ set in  ] set out</Text>
      <Text>/clip-remove FROM TO [FROM TO...]  /clip-keep FROM TO</Text>
      <Text>/speed FROM TO FACTOR  /mute FROM TO  /crop WIDTHxHEIGHT [X,Y]</Text>
      <Text>/open path  /version [all]  /revert id  /undo  /export [path] popup</Text>
      <Text>/version-limits [N]  /model model picker  /bg-music music browser</Text>
      <Text>/assets asset browser  (also Shift+A)</Text>
      <Text>/permissions [ask|auto]  /harness-model [MODEL]</Text>
      <Text dimColor>Type / for commands, use ↑/↓ to choose, and Tab to complete.</Text>
      <Text dimColor>Or ask Luna normally: “remove the first two seconds and the last ten”.</Text>
      <Text dimColor>Esc closes this panel</Text>
    </Box>
  );
}
