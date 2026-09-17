import type { Dispose, Plugin } from "../kernel/index.ts";
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
  };
  persona: { name: string; instruction: string };
  provider: { baseUrl: string; model: string; temperature: number };
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
      has(): boolean;
      get(): string;
      set(value: string): Promise<void>;
    };
    settings: { get(): Settings; apply(input: Settings): Promise<Settings> };
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
    "llm.chat": {
      stream(input: {
        settings: Settings["provider"];
        messages: { role: string; content: string }[];
        signal: AbortSignal;
      }): AsyncIterable<string>;
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
  },
  persona: {
    name: "小森",
    instruction:
      "你是住在用户桌面上的小伙伴小森。温暖、自然、简洁地用中文交流，不假装自己能看到屏幕或执行操作。",
  },
  provider: {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "",
    temperature: 0.7,
  },
};
