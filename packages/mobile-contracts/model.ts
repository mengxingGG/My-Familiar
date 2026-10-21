import type { MobileProviderKind } from "./index.ts";
export type MobileThinkingMode =
  | "auto"
  | "off"
  | "effort"
  | "budget"
  | "adaptive";
export interface MobileProviderAdvanced {
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number;
  contextTokens: number | null;
  autoCompactPercent: number;
  timeoutSeconds: number;
  thinking: { mode: MobileThinkingMode; effort: string; budgetTokens: number };
  cache: boolean;
}
export interface MobileModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  inputLimit?: number;
  outputLimit?: number;
  inputModalities?: string[];
}
export interface MobileModelQuery {
  kind: MobileProviderKind;
  baseUrl: string;
  model: string;
  advanced?: MobileProviderAdvanced;
}
export interface MobileModelInspection {
  hasKey: boolean;
  model?: MobileModelInfo;
  options: {
    modes: MobileThinkingMode[];
    efforts: string[];
    temperature: boolean;
    temperatureMax: number;
    topP: boolean;
    topPMin: number;
    budgetMin: number;
    budgetMax?: number;
    hint: string;
  };
}
export interface MobileContextStatus {
  id: string;
  epoch: number;
  retainedMessages: number;
  inputTokens: number;
  exact: boolean;
  inputBudget: number;
  limitSource: "model" | "manual" | "fallback";
  trimmedMessages: number;
  compactions: number;
  compactThreshold?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
  };
}
export interface MobileContext {
  conversationId: string;
  active: boolean;
  status?: MobileContextStatus;
  checkpoint?: {
    id: string;
    created: number;
    compactions: number;
    truncated: boolean;
    summary: {
      goals: string[];
      constraints: string[];
      facts: string[];
      decisions: string[];
      progress: string[];
      pending: string[];
      uncertainties: string[];
      artifacts: string[];
    };
  };
}
export interface MobileModelCommands {
  "provider.models": {
    params: MobileModelQuery & { refresh?: boolean };
    result: {
      kind: MobileProviderKind;
      baseUrl: string;
      items: MobileModelInfo[];
    };
  };
  "provider.inspect": {
    params: MobileModelQuery;
    result: MobileModelInspection;
  };
  /** 仅测试与参数一致的已保存配置，发送固定测试句，不发送会话与记忆。 */
  "provider.test": {
    params: MobileModelQuery & { operationId: string };
    result: { connected: true; elapsedMs: number };
  };
  "provider.test.cancel": { params: { operationId: string }; result: void };
  "conversation.context": {
    params: { conversationId: string };
    result: MobileContext;
  };
  "context.archive": {
    params: {
      conversationId: string;
      checkpoint: string;
      offset?: number;
      query?: string;
    };
    result: {
      text: string;
      nextOffset: number | null;
      totalCharacters: number;
      previous?: string;
    };
  };
}
