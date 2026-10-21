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
      /** 完整已执行工具轮次归档；只缩短后续请求，不重放或删除审计记录。 */
      archiveTools?(input: { sessionId: string; messages: PromptMessage[]; signal: AbortSignal }): Promise<{ id: string; totalCharacters: number; sha256: string }>;
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
        limit?: number,
      ): Promise<{
        text: string;
        nextOffset: number | null;
        totalCharacters: number;
        previous?: string;
      }>;
    };
  }
}
