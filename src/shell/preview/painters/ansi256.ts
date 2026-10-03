const CUBE = [0, 95, 135, 175, 215, 255] as const;

const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
] as const;

/** Half of the gap to the next palette step that dithering is allowed to move a colour: small enough that a colour that is already in the palette never changes. */
const DITHER_AMPLITUDE = 12;

function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function nearestLevel(value: number): number {
  let best = 0;
  for (let index = 1; index < CUBE.length; index += 1) {
    if (Math.abs(value - (CUBE[index] as number)) < Math.abs(value - (CUBE[best] as number))) best = index;
  }
  return best;
}

/** The xterm 256-colour index closest to the colour: the 6x6x6 cube (16 to 231) or the grey ramp (232 to 255). */
export function nearestAnsi256(red: number, green: number, blue: number): number {
  const r = nearestLevel(red);
  const g = nearestLevel(green);
  const b = nearestLevel(blue);
  const cubeDistance = (red - (CUBE[r] as number)) ** 2 + (green - (CUBE[g] as number)) ** 2 + (blue - (CUBE[b] as number)) ** 2;
  const steps = Math.max(0, Math.min(23, Math.round(((red + green + blue) / 3 - 8) / 10)));
  const grey = 8 + steps * 10;
  const greyDistance = (red - grey) ** 2 + (green - grey) ** 2 + (blue - grey) ** 2;
  return greyDistance < cubeDistance ? 232 + steps : 16 + 36 * r + 6 * g + b;
}

/**
 * The same half-block picture as `rgbToAnsi`, in the 256-colour palette, with a little ordered dithering against
 * banding. A colour code is written only when it changes from the cell before it.
 */
export function rgbToAnsi256(buffer: Buffer, width: number, height: number): string {
  const lines: string[] = [];
  const index = (x: number, y: number): number => {
    const offset = (Math.min(y, height - 1) * width + x) * 3;
    const shift = ((BAYER_4X4[(y & 3) * 4 + (x & 3)] as number) - 7.5) * (DITHER_AMPLITUDE / 7.5);
    return nearestAnsi256(clamp((buffer[offset] ?? 0) + shift), clamp((buffer[offset + 1] ?? 0) + shift), clamp((buffer[offset + 2] ?? 0) + shift));
  };
  for (let y = 0; y < height; y += 2) {
    let line = "";
    let foreground = -1;
    let background = -1;
    for (let x = 0; x < width; x += 1) {
      const top = index(x, y);
      const bottom = index(x, y + 1);
      if (top !== foreground) { line += `\u001B[38;5;${top}m`; foreground = top; }
      if (bottom !== background) { line += `\u001B[48;5;${bottom}m`; background = bottom; }
      line += "▀";
    }
    lines.push(`${line}\u001B[0m`);
  }
  return lines.join("\n");
}
