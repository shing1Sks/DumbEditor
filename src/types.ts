export interface MediaInfo {
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  formatName: string;
}

export interface TimeRange {
  start: number;
  end: number;
}

export type DirectAction = "remove" | "trim" | "speed" | "mute" | "crop";
export type Route = DirectAction | "explain" | "agent";

export type DirectEdit =
  | { action: "remove"; ranges: TimeRange[] }
  | { action: "trim"; range: TimeRange }
  | { action: "speed"; range: TimeRange; factor: number }
  | { action: "mute"; range: TimeRange }
  | { action: "crop"; width: number; height: number; x?: number; y?: number };

export interface RouteDecision {
  route: Route;
  confidence: number;
  probabilities: Record<string, number>;
  model: string;
}

export interface VersionEntry {
  id: string;
  parentId: string | null;
  filePath: string;
  action: string;
  request: string;
  createdAt: string;
  duration: number;
  agent?: boolean;
}

export interface ProjectState {
  schemaVersion: 1;
  sourcePath: string;
  projectDir: string;
  currentVersionId: string;
  nextVersion: number;
  createdAt: string;
  versions: VersionEntry[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface Selection {
  in: number | null;
  out: number | null;
}

export interface AgentResult {
  outputPath: string;
  summary: string;
  model: string;
}
