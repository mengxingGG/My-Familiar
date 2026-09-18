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
export * from "./agent.ts";
export * from "./companion.ts";
export type PetAction = "idle" | "greet" | "drag" | "think" | "sleep" | "happy";
export interface Character {
  id: string;
  name: string;
  description: string;
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
  persona: { name: string; instruction: string };
  provider: ProviderSettings;
}
export interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: "complete" | "streaming" | "cancelled" | "error";
  time: number;
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
    kind: "pet" | "composer" | "speech" | "controller",
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
    "config.provider": ConfigSection<Settings["provider"]>;
    "platform.autostart": { get(): boolean; set(enabled: boolean): boolean };
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
      test(): Promise<string>;
    };
    conversation: {
      state(): ChatState;
      send(text: string): Promise<void>;
      cancel(): Promise<void>;
      clear(): Promise<void>;
    };
    "transport.client": { call(name: string, params?: unknown): Promise<any> };
  }
}
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
    instruction:
      "你是住在用户桌面上的小伙伴小森。温暖、自然、简洁地用中文交流，不假装自己能看到屏幕或执行操作。",
  },
  provider: {
    ...profileDefaults,
    temperature: 0.7,
    savedProfiles: {},
  },
};
