import type { Message } from "./index.ts";
export interface ConversationSummary {
  id: string;
  title: string;
  updated: number;
  count: number;
}
export interface CareSettings {
  enabled: boolean;
  custom: CareReminder[];
  location: boolean;
  nearby: boolean;
}
export interface CareReminder {
  id: string;
  label: string;
  prompt: string;
  time: string;
  enabled: boolean;
}
export interface DeviceLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  source: string;
  time: number;
}
declare module "../kernel/index.ts" {
  interface Services {
    "conversation.history": {
      list(query?: string): Promise<ConversationSummary[]>;
      read(
        id: string,
        offset?: number,
      ): Promise<{
        session: ConversationSummary;
        messages: Message[];
        next: number | null;
        active: boolean;
      }>;
      create(): Promise<string>;
      select(id: string): Promise<void>;
      rename(id: string, title: string): Promise<void>;
      remove(id: string): Promise<void>;
      current(): string;
      note(text: string): Promise<void>;
    };
    "companion.presentation": {
      controller(active: boolean): void;
      inController(): boolean;
    };
    "platform.location": {
      locate(prompt: boolean, signal: AbortSignal): Promise<DeviceLocation>;
      openSettings(): void;
    };
    "companion.places": {
      nearby(location: DeviceLocation, signal: AbortSignal): Promise<string>;
    };
    "companion.care": {
      get(): {
        settings: CareSettings;
        busy: boolean;
        lastError?: string;
        lastMessage?: string;
        location?: DeviceLocation;
      };
      set(value: CareSettings): Promise<CareSettings>;
      locate(): Promise<DeviceLocation>;
      preview(): Promise<string>;
    };
  }
}
