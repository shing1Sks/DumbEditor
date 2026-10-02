/**
 * Build an AgentTool from an existing hand-written raw JSON Schema.
 *
 * `Type.Unsafe(raw)` returns the raw schema object unchanged (JSON.stringify equals the input), typed
 * as TUnsafe<TArgs>. pi then validates tool-call arguments against it with typebox (Compile + Check).
 *
 * GOTCHA (verified): before checking, pi runs `Value.Convert` + its own JSON-schema coercion on the
 * arguments, so validation is LENIENT: "12" -> 12 for integers, 7 -> "7" for strings, and `null` for a
 * NON-nullable required string/integer is silently coerced to "" / 0 and passes. Nullable unions such
 * as {type:["integer","null"]} keep `null` as null. Pass `strict: true` to reject anything that does
 * not match the raw schema exactly (checked in `prepareArguments`, i.e. before coercion).
 */
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { type TUnsafe, Type } from "typebox";
import { Compile } from "typebox/compile";

export interface JsonSchemaToolDef<TArgs, TDetails> {
  name: string;
  label?: string;
  description: string;
  /** The hand-written JSON Schema (type: "object", required, additionalProperties: false, ...). */
  jsonSchema: Record<string, unknown>;
  strict?: boolean;
  executionMode?: "sequential" | "parallel";
  execute: (
    toolCallId: string,
    args: TArgs,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
  ) => Promise<AgentToolResult<TDetails>>;
}

export function toolFromJsonSchema<TArgs = Record<string, unknown>, TDetails = unknown>(
  def: JsonSchemaToolDef<TArgs, TDetails>,
): AgentTool<TUnsafe<TArgs>, TDetails> {
  const parameters = Type.Unsafe<TArgs>(def.jsonSchema);
  const strictValidator = def.strict ? Compile(parameters) : undefined;
  return {
    name: def.name,
    label: def.label ?? def.name,
    description: def.description,
    parameters,
    ...(def.executionMode ? { executionMode: def.executionMode } : {}),
    ...(strictValidator
      ? {
          prepareArguments: (args: unknown) => {
            if (strictValidator.Check(args)) return args as TArgs;
            const errors = [...strictValidator.Errors(args)]
              .map((e) => `  - ${e.instancePath || "root"}: ${e.message}`)
              .join("\n");
            throw new Error(`Invalid arguments for tool "${def.name}":\n${errors}`);
          },
        }
      : {}),
    execute: def.execute,
  };
}
