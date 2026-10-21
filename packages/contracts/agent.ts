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
  session?: string;
  label?: string;
}
export interface ToolEntry extends ToolSpec {
  /** 按需目录中的实现仍保留参数校验与审批，但不把完整定义塞入每轮模型请求。 */
  advertised?: boolean;
  /** 目录入口不应再被另一个目录重复收录。 */
  catalogRoute?: boolean;
  denialKey?: (args: Record<string, unknown>) => string;
  /** 仅缩短可重新查询的中间资料；完整结果仍保存在执行记录中。completed 是其后的已完成调用。 */
  compactResult?: (call: ToolCall, result: string, completed: readonly ToolCall[]) => string | undefined;
  approval?: boolean;
  category?: ToolCategory;
  /** 只用于内置记忆和目录路由；联网搜索由 search 类别始终放行。 */
  alwaysAllowed?: boolean;
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
  choices?: ApprovalChoice[];
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
  /** custom 仅兼容旧配置，读取后归入 limited。 */
  mode: "custom" | "limited" | "approval" | "deny" | "auto";
  defaults: Record<ToolCategory, "allow" | "ask" | "deny">;
  whitelist: { key: string; label: string }[];
}
export interface PermissionIntent {
  tool: string;
  category: ToolCategory;
  scope: string;
  session?: string;
  alwaysAllowed?: boolean;
}
export interface SkillInfo {
  id: string;
  description: string;
  enabled: boolean;
  source: string;
  error?: string;
  /** 平台禁用的内置技能不能通过切换开关启用。 */
  supported?: boolean;
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
      compactList?(): ToolSpec[];
      denialKey?(call: ToolCall): string;
      compactResults?(messages: PromptMessage[]): PromptMessage[];
      run(
        call: ToolCall,
        signal: AbortSignal,
        options?: { silent?: boolean; session?: string; label?: string },
      ): Promise<string>;
      runRich?(
        call: ToolCall,
        signal: AbortSignal,
        options?: { silent?: boolean; session?: string; label?: string; expectedTool?: ToolEntry },
      ): Promise<{
        text: string;
        attachments?: import("./media.ts").Attachment[];
      }>;
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
          silent?: boolean;
          permissionSession?: string;
          permissionLabel?: string;
          archiveSession?: string;
        },
      ): AsyncIterable<string>;
    };
    "mcp.manager": {
      list(): Promise<
        (McpConfig & {
          connected: boolean;
          tools: number;
          toolNames?: string[];
          hasKey: boolean;
          error?: string;
        })[]
      >;
      save(config: McpConfig, update?: { expectedRevision?: string | null; expectedKey?: string; key?: string; officialGithub?: true }): Promise<void>;
      setKey(id: string, key: string): Promise<void>;
      connect(id: string, options?: { signal?: AbortSignal; expectedRevision?: string }): Promise<{ tools: string[] }>;
      disconnect(id: string): Promise<void>;
      callReadOnly(
        id: string,
        tool: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
      ): Promise<unknown>;
      remove(id: string, update?: { expectedRevision?: string; clearKey?: boolean }): Promise<void>;
      installPackage(
        id: string,
        pkg: string,
        signal?: AbortSignal,
      ): Promise<void>;
    };
  }
}
