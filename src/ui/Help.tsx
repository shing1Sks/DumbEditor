import React from "react";
import { Box, Text } from "ink";

export function Help() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">DumbEditor controls</Text>
      <Text>Space play/pause  ←/→ seek 5s  ↑/↓ volume  [ set in  ] set out</Text>
      <Text>/open path  /version [all]  /revert id  /undo  /export path</Text>
      <Text>/status  /clear  /help  /quit</Text>
      <Text dimColor>Example: remove from 00:00 to 00:03 and from 01:20 to the end</Text>
      <Text dimColor>Example: speed up this marked section at 2x</Text>
      <Text dimColor>Esc closes this panel</Text>
    </Box>
  );
}
