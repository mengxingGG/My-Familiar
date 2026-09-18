import type { Dispose } from "../kernel/index.ts";
import type { ProviderInput, PromptMessage } from "./llm.ts";
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ToolContext {
  signal: AbortSignal;
}
export interface ToolEntry extends ToolSpec {
  approval?: boolean;
  category?: ToolCategory;
  permission?: (
    args: any,
  ) => Promise<{ category: ToolCategory; scope: string }>;
  execute(args: any, context: ToolContext): Promise<unknown>;
}
export interface Approval {
  id: string;
  title: string;
  detail: string;
  time: number;
  category?: ToolCategory;
  rule?: string;
}
export type ToolCategory =
  | "read"
  | "search"
  | "write"
  | "outsideWrite"
  | "shell"
  | "install"
  | "mcp";
export type ApprovalChoice = "once" | "session" | "whitelist";
export interface ToolPolicy {
  mode: "custom" | "auto";
  defaults: Record<ToolCategory, "allow" | "ask" | "deny">;
  whitelist: { key: string; label: string }[];
}
export interface PermissionIntent {
  tool: string;
  category: ToolCategory;
  scope: string;
}
export interface SkillInfo {
  id: string;
  description: string;
  enabled: boolean;
  source: string;
  error?: string;
}
export interface McpConfig {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  auth?: { kind: "header" | "env" | "query"; name: string; prefix?: string };
}
declare module "../kernel/index.ts" {
  interface Services {
    "familiar.home": { root: string };
    "memory.files": {
      list(): Promise<string[]>;
      read(path: string): Promise<{ text: string; revision: string }>;
      write(path: string, text: string, revision?: string): Promise<void>;
      context(): Promise<string>;
      remember(
        text: string,
        signal?: AbortSignal,
      ): Promise<{ refined: boolean }>;
      lesson(title: string, text: string, category?: string): Promise<string>;
      search(query: string): Promise<{ path: string; excerpt: string }[]>;
      record(turn: {
        id: string;
        user: string;
        assistant: string;
        time: number;
      }): Promise<void>;
      status(): { root: string; lastError?: string; refining: boolean };
    };
    "skills.catalog": {
      list(): Promise<SkillInfo[]>;
      read(id: string, path?: string): Promise<string>;
      install(
        source: string,
        content?: string,
        signal?: AbortSignal,
      ): Promise<SkillInfo>;
      setEnabled(id: string, enabled: boolean): Promise<void>;
      remove(id: string): Promise<void>;
      prompt(): Promise<string>;
    };
    "agent.tools": {
      register(tool: ToolEntry): Dispose;
      list(): ToolSpec[];
      run(call: ToolCall, signal: AbortSignal): Promise<string>;
    };
    "agent.approvals": {
      list(): Approval[];
      request(
        title: string,
        detail: string,
        signal: AbortSignal,
        intent?: PermissionIntent,
      ): Promise<void>;
      decide(
        id: string,
        allow: boolean,
        choice?: ApprovalChoice,
      ): Promise<void>;
    };
    "agent.policy": {
      get(): ToolPolicy;
      set(policy: ToolPolicy): Promise<ToolPolicy>;
      resetSession(): void;
    };
    "agent.chat": {
      stream(
        input: Omit<ProviderInput, "key"> & {
          onTrace?: (messages: PromptMessage[]) => void;
        },
      ): AsyncIterable<string>;
    };
    "mcp.manager": {
      list(): Promise<
        (McpConfig & {
          connected: boolean;
          tools: number;
          hasKey: boolean;
          error?: string;
        })[]
      >;
      save(config: McpConfig): Promise<void>;
      setKey(id: string, key: string): Promise<void>;
      connect(id: string): Promise<{ tools: string[] }>;
      callReadOnly(
        id: string,
        tool: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ): Promise<unknown>;
      remove(id: string): Promise<void>;
      installPackage(
        id: string,
        pkg: string,
        signal?: AbortSignal,
      ): Promise<void>;
    };
  }
}
