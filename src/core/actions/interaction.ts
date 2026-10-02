import { objectSchema, stringSchema, string } from "./schema.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

export function createInteractionActions(): Action<any>[] {
  return [
    {
      name: "present_choices",
      description: "Open a native DumbEditor choice picker when the user should choose between several creative directions. The picker also has a custom answer field. Use it instead of printing a list of options when the answer should guide the current request.",
      schema: objectSchema({
        question: stringSchema(1, 500),
        options: { type: "array", minItems: 2, maxItems: 6, items: stringSchema(1, 160) },
        allow_custom: { type: "boolean" },
      }),
      risk: "read",
      describe: (args: Args) => `Ask: ${String(args.question).slice(0, 80)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        if (!Array.isArray(args.options) || !args.options.every((option) => typeof option === "string")) throw new Error("options must be an array of text choices.");
        const answer = await ctx.requestChoice({
          question: string(args.question, "question"),
          options: args.options.map((option) => option.trim()),
          allowCustom: args.allow_custom === true,
        });
        if (answer === null) throw new Error("The user cancelled the choice picker.");
        return { text: `The user chose: ${answer}`, data: { answer } };
      },
    },
  ];
}
