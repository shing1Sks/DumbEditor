import React from "react";
import { Box, Text } from "ink";

export function Help({ model = "agent" }: { model?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">DumbEditor controls</Text>
      <Text>Ctrl+P play/pause  ←/→ seek 5s  +/- volume  [ set in  ] set out</Text>
      <Text>/clip-remove FROM TO [FROM TO...]  /clip-keep FROM TO</Text>
      <Text>/speed FROM TO FACTOR  /mute FROM TO  /crop WIDTHxHEIGHT [X,Y]</Text>
      <Text>/open path  /projects  /version [all]  /revert id  /undo</Text>
      <Text>/export [path] popup  /version-limits [N]  /model model picker</Text>
      <Text>/bg-music music browser  /assets asset browser  (also Shift+A)</Text>
      <Text>/permissions [ask|auto]  /harness-model [MODEL]</Text>
      <Text dimColor>Type / for commands, use ↑/↓ to choose, and Tab to complete.</Text>
      <Text dimColor>↑/↓ scroll chat, PgUp/PgDn move a page, Ctrl+G expands chat.</Text>
      <Text dimColor>Ask {model} normally: “remove the first two seconds and the last ten”.</Text>
      <Text dimColor>Esc closes this panel</Text>
    </Box>
  );
}
