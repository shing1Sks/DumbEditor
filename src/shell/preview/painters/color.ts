export type ColorMode = "truecolor" | "256";

/**
 * How many colours block art can use. Every terminal is assumed to have 24-bit colour, as before, except Terminal.app
 * when it does not say so (it shows only 256 colours on older macOS and never announces that, so `TERM` cannot tell).
 * DUMBEDITOR_COLOR=truecolor or 256 decides explicitly.
 */
export function colorMode(environment: NodeJS.ProcessEnv = process.env): ColorMode {
  const forced = environment.DUMBEDITOR_COLOR?.trim().toLowerCase();
  if (forced === "truecolor" || forced === "256") return forced;
  const announced = /^(truecolor|24bit)$/i.test(environment.COLORTERM ?? "");
  if (environment.TERM_PROGRAM === "Apple_Terminal" && !announced) return "256";
  return "truecolor";
}
