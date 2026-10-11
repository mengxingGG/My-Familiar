import type { ContextPlan, PromptMessage, ProviderProfile } from "./llm.ts";

export const summaryFields = [
  "goals",
  "constraints",
  "facts",
  "decisions",
  "progress",
  "pending",
  "uncertainties",
  "artifacts",
] as const;
export type ContextSummary = Record<(typeof summaryFields)[number], string[]>;
export interface ContextCheckpoint {
  id: string;
  summary: ContextSummary;
  throughId: string;
  previous?: string;
  created: number;
}
export interface ContextInput {
  sessionId: string;
  system: PromptMessage;
  /** 发生压缩时改用的新系统前缀（例如刷新后的记忆快照）；dropped 为 0 时调用方继续使用 system。 */
  nextSystem?: PromptMessage;
  history: (PromptMessage & { id: string })[];
  checkpoint?: ContextCheckpoint;
  settings: ProviderProfile;
  plan: ContextPlan;
  toolTokens: number;
  signal: AbortSignal;
}
declare module "../kernel/index.ts" {
  interface Services {
    "context.compaction": {
      forget(sessionId: string): Promise<void>;
      prepare(input: ContextInput): Promise<{
        messages: PromptMessage[];
        checkpoint?: ContextCheckpoint;
        dropped: number;
        tokens: number;
        exact: boolean;
        threshold: number;
      }>;
      read(
        id: string,
        offset?: number,
        query?: string,
      ): Promise<{
        text: string;
        nextOffset: number | null;
        totalCharacters: number;
        previous?: string;
      }>;
    };
  }
}
