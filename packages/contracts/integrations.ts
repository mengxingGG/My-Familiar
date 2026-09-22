import type { PromptMessage } from "./llm.ts";
export interface FeishuSettings {
  officeEnabled: boolean;
  channelEnabled: boolean;
  identity: "user" | "bot";
  allowedUsers: string[];
}
export interface IntegrationJob {
  kind: string;
  running: boolean;
  output: string;
  url?: string;
  error?: string;
}
export interface FeishuAccessIssue {
  command: string;
  identity: FeishuSettings["identity"];
  scopes: string[];
}
declare module "../kernel/index.ts" {
  interface Services {
    "feishu.cli": {
      status(): Promise<{
        config: FeishuSettings;
        root: string;
        installed: boolean;
        version: string;
        job?: IntegrationJob;
        channel: string;
        error?: string;
        accessIssues: FeishuAccessIssue[];
        pairing?: { code: string; expires: number };
        lastSender?: string;
      }>;
      save(config: FeishuSettings): Promise<void>;
      install(): Promise<void>;
      configure(appId: string, appSecret: string): Promise<void>;
      createApp(): Promise<void>;
      authorize(scope: string): Promise<void>;
      authorizeOffice(): Promise<void>;
      check(): Promise<void>;
      cancelJob(): Promise<void>;
      pair(): void;
      openAuthorization(): Promise<void>;
    };
    "github.integration": {
      status(): Promise<{
        enabled: boolean;
        readOnly: boolean;
        hasKey: boolean;
        connected: boolean;
        tools: number;
        error?: string;
        authMode: "browser" | "token";
        installed: boolean;
        job?: IntegrationJob;
      }>;
      save(input: {
        enabled: boolean;
        readOnly: boolean;
        token?: string;
        authMode: "browser" | "token";
      }): Promise<void>;
      connect(): Promise<{ tools: string[] }>;
      install(): Promise<void>;
      login(): Promise<void>;
      cancelJob(): Promise<void>;
      openAuthorization(): Promise<void>;
    };
    "channel.chat": {
      reply(
        channel: string,
        text: string,
        signal: AbortSignal,
      ): Promise<string>;
      history(channel: string): Promise<PromptMessage[]>;
      clear(channel: string): Promise<void>;
    };
  }
}
