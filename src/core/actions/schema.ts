// Schema builders and argument readers shared by action definitions. Every action schema lists all of
// its properties as required and forbids extra properties; optional values are nullable instead.

export function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}
export function rangeSchema() { return objectSchema({ start: numberSchema(0), end: numberSchema(0) }); }
export function numberSchema(minimum: number) { return { type: "number", minimum }; }
export function nullableInteger(minimum: number) { return { type: ["integer", "null"], minimum }; }
export function stringSchema(minLength: number, maxLength: number) { return { type: "string", minLength, maxLength }; }

export function range(args: Record<string, unknown>) { return { start: number(args.start, "start"), end: number(args.end, "end") }; }
export function ranges(value: unknown) {
  if (!Array.isArray(value)) throw new Error("ranges must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each range must be an object");
    return range(item as Record<string, unknown>);
  });
}
export function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  return value;
}
export function integer(value: unknown, label: string): number {
  const result = number(value, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be a whole number`);
  return result;
}
export function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  return value;
}

export function jsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${label} must contain valid JSON.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must contain a JSON object.`);
  return parsed as Record<string, unknown>;
}

export function optionalOverride(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  if (!result || ["null", "undefined", "default", "none"].includes(result.toLowerCase())) return undefined;
  return result;
}

export function optionalJsonObject(value: unknown, label: string): Record<string, unknown> | undefined {
  const text = optionalOverride(value);
  if (!text) return undefined;
  const parsed = jsonObject(text, label);
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}
