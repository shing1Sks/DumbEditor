import { loadAgentSkills } from "../agent-skills.js";
import { localSandboxStatus, runSandboxScript } from "../sandbox.js";
import { integer, objectSchema, string, stringSchema } from "./schema.js";
import type { Action, ActionContext, ActionResult } from "./types.js";

type Args = Record<string, unknown>;

export function createWorkspaceActions(): Action<any>[] {
  return [
    {
      name: "write_workspace_file",
      description: "Write a text file such as SRT subtitles, ASS captions, JSON, or a reusable script into the isolated project workspace. This does not execute scripts.",
      schema: objectSchema({ path: stringSchema(1, 240), content: stringSchema(0, 1_000_000) }),
      risk: "edit",
      describe: (args: Args) => `Write ${String(args.path)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Workspace file written",
        data: { path: await ctx.state.workspace.writeText(string(args.path, "path"), string(args.content, "content")) },
      }),
    },
    {
      name: "read_workspace_file",
      description: "Read a text file from the isolated project workspace.",
      schema: objectSchema({ path: stringSchema(1, 240) }),
      risk: "read",
      describe: (args: Args) => `Read ${String(args.path)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Workspace file contents", data: { content: await ctx.state.workspace.readText(string(args.path, "path")) },
      }),
    },
    {
      name: "list_workspace_files",
      description: "List text files in the isolated project workspace.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "List workspace files",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Workspace files", data: { files: await ctx.state.workspace.listFiles() },
      }),
    },
    {
      name: "run_sandbox_script",
      description: "Run a Python or JavaScript file written to the project workspace through DumbEditor's local OS sandbox. Call sandbox_status first. The active video path is passed as the script's first argument; only the project workspace is writable; network and host API keys are unavailable.",
      schema: objectSchema({
        language: { type: "string", enum: ["python", "javascript"] },
        workspace_path: stringSchema(1, 240),
        arguments: { type: "array", maxItems: 30, items: stringSchema(0, 500) },
      }),
      risk: "code",
      describe: (args: Args) => `Run ${String(args.language)} script ${String(args.workspace_path)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => {
        if (!Array.isArray(args.arguments) || !args.arguments.every((item) => typeof item === "string")) throw new Error("arguments must be an array of strings.");
        ctx.progress({ stage: "Running isolated script" });
        const result = await runSandboxScript({
          language: args.language as "python" | "javascript",
          workspace: ctx.state.workspace,
          workspacePath: string(args.workspace_path, "workspace_path"),
          activeVideoPath: ctx.state.store.current.filePath,
          arguments: args.arguments,
          signal: ctx.signal,
        });
        return { text: "Sandbox script completed.", data: result as unknown as Record<string, unknown> };
      },
    },
    {
      name: "sandbox_status",
      description: "Report the project workspace boundary and whether arbitrary script execution is safely available.",
      schema: objectSchema({}),
      risk: "read",
      describe: () => "Check sandbox status",
      run: async (_args: Args, ctx: ActionContext): Promise<ActionResult> => {
        const sandbox = await localSandboxStatus();
        return {
          text: sandbox.available
            ? `Custom FFmpeg and isolated script execution are available through ${sandbox.detail}.`
            : `Custom FFmpeg is available. Isolated scripts are disabled: ${sandbox.detail}.`,
          data: { root: ctx.state.workspace.root, scriptExecution: sandbox.available, sandbox: sandbox.detail, customFfmpeg: true, builtInFfmpegTools: true },
        };
      },
    },
    {
      name: "search_project_chat",
      description: "Search the complete local project transcript for older requests or decisions.",
      schema: objectSchema({ query: stringSchema(1, 500), limit: { type: "integer", minimum: 1, maximum: 50 } }),
      risk: "read",
      describe: (args: Args) => `Search chat: ${String(args.query)}`,
      run: async (args: Args, ctx: ActionContext): Promise<ActionResult> => ({
        text: "Chat search results",
        data: { messages: await ctx.state.store.searchChat(string(args.query, "query"), integer(args.limit, "limit")) },
      }),
    },
    {
      name: "read_skill",
      description: "Load the full text of one packaged DumbEditor skill listed in the system prompt.",
      schema: objectSchema({ name: stringSchema(1, 80) }),
      risk: "read",
      describe: (args: Args) => `Read skill ${String(args.name)}`,
      run: async (args: Args): Promise<ActionResult> => {
        const name = string(args.name, "name");
        const skills = await loadAgentSkills();
        const skill = skills.find((item) => item.name === name);
        if (!skill) throw new Error(`Unknown skill ${name}. Available: ${skills.map((item) => item.name).join(", ")}`);
        return { text: skill.body };
      },
    },
  ];
}
