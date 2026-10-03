const CUBE = [0, 95, 135, 175, 215, 255] as const;

const BAYER_4X4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
] as const;

/** How far dithering may move a colour (the grey ramp steps by 10, the cube by 40 or more). */
const DITHER_AMPLITUDE = 12;
/** A colour this close to a palette entry (squared distance) is used as it is: dithering it would only add noise, and break up runs of one colour. */
const EXACT_DISTANCE = 3 * 6 * 6;

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

/** The RGB of an xterm 256-colour index in the cube or grey ramp. */
export function paletteColor(index: number): [number, number, number] {
  if (index >= 232) { const grey = 8 + (index - 232) * 10; return [grey, grey, grey]; }
  const cube = index - 16;
  return [CUBE[Math.floor(cube / 36)] as number, CUBE[Math.floor(cube / 6) % 6] as number, CUBE[cube % 6] as number];
}

/**
 * The same half-block picture as `rgbToAnsi`, in the 256-colour palette, with a little ordered dithering against
 * banding. A colour code is written only when it changes from the cell before it.
 */
export function rgbToAnsi256(buffer: Buffer, width: number, height: number): string {
  const lines: string[] = [];
  const index = (x: number, y: number): number => {
    const offset = (Math.min(y, height - 1) * width + x) * 3;
    const red = buffer[offset] ?? 0;
    const green = buffer[offset + 1] ?? 0;
    const blue = buffer[offset + 2] ?? 0;
    const plain = nearestAnsi256(red, green, blue);
    const [pr, pg, pb] = paletteColor(plain);
    if ((red - pr) ** 2 + (green - pg) ** 2 + (blue - pb) ** 2 <= EXACT_DISTANCE) return plain;
    const shift = ((BAYER_4X4[(y & 3) * 4 + (x & 3)] as number) - 7.5) * (DITHER_AMPLITUDE / 7.5);
    return nearestAnsi256(clamp(red + shift), clamp(green + shift), clamp(blue + shift));
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
