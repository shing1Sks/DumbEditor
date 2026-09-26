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

export type DirectEdit =
  | { action: "remove"; ranges: TimeRange[] }
  | { action: "trim"; range: TimeRange }
  | { action: "speed"; range: TimeRange; factor: number }
  | { action: "mute"; range: TimeRange }
  | { action: "crop"; width: number; height: number; x?: number; y?: number };

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
  /** Human-readable title derived from the first natural-language request. */
  name?: string;
  updatedAt?: string;
  /** Number of rendered edit versions retained in addition to the source. */
  versionLimit?: number;
  versions: VersionEntry[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
  /** Stable display identity for the model or editor component that produced the message. */
  label?: string;
}

export interface Selection {
  in: number | null;
  out: number | null;
}
