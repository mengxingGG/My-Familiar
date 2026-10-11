// 记忆分层契约，设计与迁移说明见 docs/17_Familiar_记忆系统改造方案.md。
export const memoryLimits = {
  /** CORE.md 核心规则的 Unicode 字符上限。 */
  core: 2000,
  /** 程序生成的记忆索引上限，与核心规则合计不超过 3000。 */
  index: 1000,
} as const;
export type MemoryAction = "add" | "replace" | "remove";
export type NoteLayer = "lessons" | "topics";
export interface MemoryChange {
  /** 默认 add。 */
  action?: MemoryAction;
  /** add / replace 的新条目正文。 */
  text?: string;
  /** replace / remove 时用于唯一定位已有条目的原文片段。 */
  old?: string;
  /** 判断为重复或取代时，确认仍要新增。 */
  force?: boolean;
}
export interface NoteChange extends MemoryChange {
  topic: string;
  /** 何时该读这个文件；新主题必填，已有主题填写时更新。 */
  when?: string;
}
export interface MemoryJudgement {
  relation: "duplicate" | "supersede";
  entry: string;
  backend: string;
}
export interface MemoryWriteResult {
  path: string;
  action: MemoryAction;
  /** 由代码重新读取文件确认的结果。 */
  written: boolean;
  entries: number;
  characters: number;
  limit?: number;
  judgement?: MemoryJudgement;
  notice?: string;
}
export interface MemoryStatus {
  root: string;
  lastError?: string;
  core: { characters: number; limit: number };
  index: { characters: number; limit: number; omitted: number };
}
/** 选择题判断，后端可由主模型、判断模型等不同插件实现。 */
export interface JudgeQuestion {
  id: string;
  /** 题型，用于记录与离线校准，例如 memory.duplicate。 */
  kind: string;
  prompt: string;
  options: string[];
}
export interface JudgeAnswer {
  id: string;
  /** 选项序号，从 0 开始；无法判断时为 null。 */
  choice: number | null;
}
export interface JudgeResult {
  backend: string;
  answers: JudgeAnswer[];
}
/** 事件 memory.changed 的载荷。 */
export interface MemoryChanged {
  v: 1;
  source: "user" | "model";
  path: string;
}
/** 事件 memory.trace 的载荷，持久化为诊断记录，不是记忆。 */
export interface MemoryTrace {
  v: 1;
  type: "write" | "judge" | "recall" | "inject";
  time: number;
  session?: string;
  [field: string]: unknown;
}
declare module "../kernel/index.ts" {
  interface Services {
    "memory.files": {
      list(): Promise<string[]>;
      read(path: string): Promise<{ text: string; revision: string }>;
      /** 用户或管理器的整文件编辑；核心规则超限时拒绝。 */
      write(path: string, text: string, revision?: string): Promise<void>;
      /** 实时生成的身份、核心规则与索引；会话快照由调用方冻结。 */
      context(): Promise<string>;
      remember(
        change: MemoryChange,
        signal?: AbortSignal,
      ): Promise<MemoryWriteResult>;
      note(
        layer: NoteLayer,
        change: NoteChange,
        signal?: AbortSignal,
      ): Promise<MemoryWriteResult>;
      search(query: string): Promise<{ path: string; excerpt: string }[]>;
      diary(text: string, signal?: AbortSignal): Promise<string>;
      status(): MemoryStatus;
    };
    "memory.judge": {
      ask(questions: JudgeQuestion[], signal?: AbortSignal): Promise<JudgeResult>;
      status(): {
        backend: string;
        available: boolean;
        retryAt?: number;
        lastError?: string;
      };
    };
  }
}
