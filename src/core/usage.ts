import { randomUUID } from "node:crypto";

export type UsageKind = "luna" | "asset";

export interface UsageEntry {
  id: string;
  at: string;
  kind: UsageKind;
  provider: "openai" | "openrouter" | "local";
  model: string;
  label: string;
  costUsd: number;
  estimated: boolean;
  assetId?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
}

export interface UsageSummary {
  totalUsd: number;
  lunaUsd: number;
  assetUsd: number;
  entries: number;
}

export const EMPTY_USAGE_SUMMARY: UsageSummary = { totalUsd: 0, lunaUsd: 0, assetUsd: 0, entries: 0 };

export function createUsageEntry(entry: Omit<UsageEntry, "id" | "at">): UsageEntry {
  return { ...entry, id: `usage_${randomUUID().slice(0, 12)}`, at: new Date().toISOString() };
}

export function summarizeUsage(entries: UsageEntry[]): UsageSummary {
  const lunaUsd = entries.filter((entry) => entry.kind === "luna").reduce((sum, entry) => sum + entry.costUsd, 0);
  const assetUsd = entries.filter((entry) => entry.kind === "asset").reduce((sum, entry) => sum + entry.costUsd, 0);
  return { totalUsd: lunaUsd + assetUsd, lunaUsd, assetUsd, entries: entries.length };
}

export function formatUsd(value: number, estimated = false): string {
  const prefix = estimated ? "~" : "";
  if (value === 0) return `${prefix}$0.0000`;
  if (value < 0.0001) return `${prefix}$${value.toFixed(6)}`;
  if (value < 0.01) return `${prefix}$${value.toFixed(4)}`;
  return `${prefix}$${value.toFixed(2)}`;
}

export function isUsageEntry(value: unknown): value is UsageEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<UsageEntry>;
  return typeof entry.id === "string"
    && typeof entry.at === "string"
    && (entry.kind === "luna" || entry.kind === "asset")
    && ["openai", "openrouter", "local"].includes(entry.provider ?? "")
    && typeof entry.model === "string"
    && typeof entry.label === "string"
    && typeof entry.costUsd === "number"
    && Number.isFinite(entry.costUsd)
    && entry.costUsd >= 0
    && typeof entry.estimated === "boolean";
}
