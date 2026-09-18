import type { Dispose } from "../kernel/index.ts";
import type { ToolSpec, ToolCall } from "./agent.ts";

export type ThinkingMode = "auto" | "off" | "effort" | "budget" | "adaptive";
export interface ProviderProfile {
  kind: string;
  baseUrl: string;
  model: string;
  temperature: number | null;
  topP: number | null;
  maxOutputTokens: number;
  contextTokens: number | null;
  timeoutSeconds: number;
  thinking: { mode: ThinkingMode; effort: string; budgetTokens: number };
  cache: boolean;
}
export interface ProviderSettings extends ProviderProfile {
  savedProfiles: Record<string, ProviderProfile>;
}
export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  inputLimit?: number;
  outputLimit?: number;
  supportedParameters?: string[];
  thinking?: { modes: ThinkingMode[]; efforts?: string[]; mandatory?: boolean };
}
export interface ParameterSupport {
  modes: ThinkingMode[];
  efforts: string[];
  temperature: boolean;
  temperatureMax: number;
  topP: boolean;
  topPMin: number;
  budgetMin: number;
  budgetMax?: number;
  hint: string;
}
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}
export interface NativeTurn {
  scope: string;
  items: unknown[];
}
export interface PromptMessage {
  role: string;
  content: string;
  native?: NativeTurn;
  calls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}
export interface ProviderInput {
  settings: ProviderProfile;
  messages: PromptMessage[];
  signal: AbortSignal;
  key: string;
  sessionKey?: string;
  onUsage?: (usage: Usage) => void;
  onNative?: (native: NativeTurn) => void;
  nativeScope?: string;
  modelInfo?: ModelInfo;
  tools?: ToolSpec[];
  onTools?: (calls: ToolCall[]) => void;
}
export interface ProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
  requiresKey: boolean;
  options(settings: ProviderProfile, model?: ModelInfo): ParameterSupport;
  stream(input: ProviderInput): AsyncIterable<string>;
  models(
    input: Pick<ProviderInput, "settings" | "signal" | "key">,
  ): Promise<ModelInfo[]>;
  countTokens?(input: ProviderInput): Promise<number>;
}
export interface ProviderRegistry {
  register(provider: ProviderDefinition): Dispose;
  get(id: string): ProviderDefinition;
  list(): {
    id: string;
    name: string;
    defaults: ProviderProfile;
    requiresKey: boolean;
  }[];
}
export interface ContextPlan {
  inputBudget: number;
  contextWindow: number;
  source: "model" | "manual" | "fallback";
  model?: ModelInfo;
}
export interface SessionStatus {
  id: string;
  epoch: number;
  retainedMessages: number;
  inputTokens: number;
  exact: boolean;
  inputBudget: number;
  limitSource: ContextPlan["source"];
  trimmedMessages: number;
  usage?: Usage;
}
export const profileDefaults: ProviderProfile = {
  kind: "compatible",
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "",
  temperature: null,
  topP: null,
  maxOutputTokens: 4096,
  contextTokens: null,
  timeoutSeconds: 180,
  thinking: { mode: "auto", effort: "medium", budgetTokens: 2048 },
  cache: true,
};
