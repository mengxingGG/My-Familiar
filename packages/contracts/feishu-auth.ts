export interface FeishuAuthStatus {
  revision: string;
  connected: boolean;
  phase: "signedOut" | "authorizing" | "connected" | "refreshing" | "error";
  detail: string;
  appId: string;
  user?: { id: string; name: string };
  scopes: string[];
  authorization?: { url: string; userCode: string; expiresAt: number };
}
export interface FeishuAuthBegin { revision: string; channelRevision: string; scopes: string[]; }
declare module "../kernel/index.ts" {
  interface Services {
    "feishu.auth": {
      status(): FeishuAuthStatus;
      begin(value: FeishuAuthBegin): Promise<void>;
      open(revision: string): Promise<void>;
      cancel(revision: string): void;
      forget(revision: string): Promise<void>;
      token(signal: AbortSignal): Promise<string>;
    };
  }
}
