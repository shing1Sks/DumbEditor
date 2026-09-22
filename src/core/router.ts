import { AuthenticationError, choice, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ChatMessage, RouteDecision, Selection } from "../types.js";

export async function routeRequest(options: {
  request: string;
  duration: number;
  currentTime: number;
  selection: Selection;
  history: ChatMessage[];
}): Promise<RouteDecision> {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() || process.env.JEV?.trim();
  if (!apiKey) throw new Error("JEV key missing. Run `dumbeditor setup` before editing.");
  const model = process.env.JEV_MODEL?.trim() || process.env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest";
  const client = new TypeSafeClient({ apiKey, defaultModel: model });

  try {
    const response = await client.systemOne({
      state: {
        request: options.request,
        video: {
          duration_seconds: Number(options.duration.toFixed(3)),
          playhead_seconds: Number(options.currentTime.toFixed(3)),
          marked_range: { in: options.selection.in, out: options.selection.out },
        },
        capabilities: {
          direct: ["remove", "trim", "speed", "mute", "crop"],
          agent_available: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
        },
        recent_conversation: options.history.slice(-12).map(({ role, content }) => ({ role, content })),
      },
      questions: {
        route: choice(
          {
            task: "Choose exactly one DumbEditor handler for `request`.",
            policy: "Use a direct handler only when it fully expresses the requested result. Use agent for compositing, generation, content analysis, captions, effects, or custom multi-step work. Use explain only for a question about DumbEditor itself.",
          },
          {
            remove: "Delete one or more explicit or marked time ranges, then join the remaining video.",
            trim: "Keep one explicit or marked continuous time range and discard everything outside it.",
            speed: "Change playback speed for one explicit or marked time range.",
            mute: "Silence one explicit or marked time range.",
            crop: "Crop the picture to explicit width and height, optionally at x and y.",
            explain: "Ask about controls, available commands, project status, or how to use the editor without changing media.",
            agent: "Any requested media change beyond the five direct handlers, whether or not `capabilities.agent_available` is true.",
          },
        ),
      },
    });
    const answer = response.answers.route;
    return {
      route: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: response.model,
    };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      throw new Error("JEV rejected the configured API key. Run `dumbeditor setup` and enter an active TypeSafe key.", { cause: error });
    }
    throw error;
  }
}
