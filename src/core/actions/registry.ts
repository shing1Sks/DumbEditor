import type { Action, ActionContext, ActionResult, Risk } from "./types.js";

/** Everything the editor can do. Slash commands and agent tools both run actions from here. */
export class ActionRegistry {
  private readonly actions = new Map<string, Action<any>>();

  register<Args>(action: Action<Args>): this {
    if (this.actions.has(action.name)) throw new Error(`Action ${action.name} is already registered.`);
    this.actions.set(action.name, action as Action<any>);
    return this;
  }

  get(name: string): Action<any> | undefined {
    return this.actions.get(name);
  }

  list(): Action<any>[] {
    return [...this.actions.values()];
  }

  riskOf(name: string, args: unknown): Risk {
    const action = this.require(name);
    return typeof action.risk === "function" ? action.risk(args) : action.risk;
  }

  describe(name: string, args: unknown): string {
    const action = this.require(name);
    if (action.describe) return action.describe(args);
    const encoded = JSON.stringify(args) ?? "";
    return `${name} ${encoded.length > 100 ? `${encoded.slice(0, 97)}...` : encoded}`;
  }

  /** Run an action, then bring the editor state up to date when it changed the active version. */
  async run(name: string, args: unknown, ctx: ActionContext): Promise<ActionResult> {
    const action = this.require(name);
    const result = await action.run(args, ctx);
    if (result.versionId) await ctx.state.afterVersionChange();
    return result;
  }

  private require(name: string): Action<any> {
    const action = this.actions.get(name);
    if (!action) throw new Error(`Unknown action: ${name}`);
    return action;
  }
}
