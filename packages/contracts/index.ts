import type { Dispose, Plugin } from "../kernel/index.ts";
import {
  profileDefaults,
  type ProviderSettings,
  type ProviderProfile,
  type ProviderRegistry,
  type ProviderInput,
  type ModelInfo,
  type ParameterSupport,
  type ContextPlan,
  type SessionStatus,
} from "./llm.ts";
export * from "./llm.ts";
export * from "./context.ts";
export * from "./agent.ts";
export * from "./memory.ts";
export * from "./companion.ts";
export * from "./integrations.ts";
export * from "./feishu-channel.ts";
export * from "./github-auth.ts";
export * from "./media.ts";
export * from "./voice.ts";
export type PetAction = "idle" | "greet" | "drag" | "think" | "sleep" | "happy";
export interface Character {
  id: string;
  name: string;
  description: string;
  recommendedPersona?: string;
  actions: string[];
  representations: Record<string, unknown>;
}
export interface SpriteRepresentation {
  frames: Record<string, string[]>;
  fps: number;
}
export interface Settings {
  version: number;
  pet: {
    scale: number;
    topmost: boolean;
    quiet: boolean;
    character: string;
    visible: boolean;
    bubbleSeconds: number;
  };
  persona: { name: string; instruction: string; style?: string };
  provider: ProviderSettings;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "complete" | "streaming" | "cancelled" | "error";
  time: number;
  attachments?: import("./media.ts").Attachment[];
  origin?: "text" | "voice";
}
export interface ChatState {
  messages: Message[];
  busy: boolean;
  error?: string;
  session?: SessionStatus;
}
export type Command = (params: any) => unknown | Promise<unknown>;
export interface ConfigSection<T> {
  defaults: T;
  validate(value: unknown): T;
}
export interface Surface {
  create(
    kind: "pet" | "composer" | "speech" | "controller" | "voice",
    html: string,
  ): Promise<void>;
  send(kind: string, channel: string, payload: unknown): void;
  show(kind: string, visible: boolean): void;
  close(kind: string): void;
  configurePet(settings: Settings["pet"]): void;
  resizeSpeech(height: number): void;
  resetPosition(): void;
  interaction(kind: "drag-start" | "drag-end" | "hit", data?: unknown): void;
  openController(): void;
  quit(): void;
  metrics(): unknown;
}
declare module "../kernel/index.ts" {
  interface Services {
    "storage.local": {
      read<T>(key: string, fallback: T): Promise<T>;
      write(key: string, data: unknown): Promise<void>;
    };
    "secrets.local": {
      has(scope: string): boolean;
      get(scope: string): string;
      set(scope: string, value: string): Promise<void>;
    };
    settings: {
      get(): Settings;
      apply(input: Settings): Promise<Settings>;
      patchPet(patch: Partial<Settings["pet"]>): Promise<Settings>;
    };
    "config.pet": ConfigSection<Settings["pet"]>;
    "config.persona": ConfigSection<Settings["persona"]>;
    "persona.catalog": {
      list(): {
        id: string;
        name: string;
        description: string;
        example: string;
      }[];
      prompt(config: Settings): string;
    };
    "config.provider": ConfigSection<Settings["provider"]>;
    "platform.autostart": {
      get(): boolean;
      set(enabled: boolean): boolean;
      /** 无法写入系统登录启动时的原因。 */
      unavailable(): string | undefined;
    };
    commands: {
      register(name: string, command: Command): Dispose;
      call(name: string, params?: unknown): Promise<unknown>;
    };
    "platform.surface": Surface;
    "character.catalog": { list(): Character[]; get(id: string): Character };
    "renderer.pet": {
      setCharacter(id: string): Promise<void>;
      act(action: PetAction): void;
      say(text: string): void;
    };
    "behavior.pet": {
      state(): PetAction;
      interact(action: "click" | "drag-start" | "drag-end" | "sleep"): void;
    };
    "llm.registry": ProviderRegistry;
    "llm.management": {
      validate(config: ProviderProfile): ProviderProfile;
      models(config: ProviderProfile, refresh?: boolean): Promise<ModelInfo[]>;
      inspect(config: ProviderProfile): {
        options: ParameterSupport;
        model?: ModelInfo;
        hasKey: boolean;
      };
      plan(config: ProviderProfile, signal?: AbortSignal): Promise<ContextPlan>;
      count(
        input: Omit<ProviderInput, "key">,
      ): Promise<{ tokens: number; exact: boolean }>;
    };
    "llm.chat": {
      stream(input: Omit<ProviderInput, "key">): AsyncIterable<string>;
      test(options?: { settings?: ProviderProfile; signal?: AbortSignal; timeoutMs?: number }): Promise<string>;
    };
    conversation: {
      state(): ChatState;
      send(text: string | import("./media.ts").ChatInput): Promise<void>;
      cancel(): Promise<void>;
      clear(): Promise<void>;
    };
    "transport.client": { call(name: string, params?: unknown): Promise<any> };
  }
}
export type { FeishuOfficeStatus, FeishuOfficeUpdate } from "./feishu-office.ts";
export type { FeishuAuthStatus, FeishuAuthBegin } from "./feishu-auth.ts";
export const definePlugin = (plugin: Plugin) => plugin;
export const defaults: Settings = {
  version: 0,
  pet: {
    scale: 1,
    topmost: true,
    quiet: false,
    character: "mori",
    visible: true,
    bubbleSeconds: 15,
  },
  persona: {
    name: "小森",
    style: "character",
    instruction: "",
  },
  provider: {
    ...profileDefaults,
    temperature: 0.7,
    savedProfiles: {},
  },
};
