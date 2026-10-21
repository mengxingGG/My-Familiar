export interface FeishuOfficeStatus {
  enabled: boolean;
  revision: string;
  appId: string;
  identity: "bot" | "user";
  missingScopes?: string[];
  available: boolean;
  checking: boolean;
  pending: number;
  detail: string;
  checkedAt?: number;
}
export interface FeishuOfficeUpdate {
  enabled: boolean;
  revision: string;
  channelRevision: string;
  identity?: "bot" | "user";
}
declare module "../kernel/index.ts" {
  interface Services {
    "feishu.office": {
      status(): FeishuOfficeStatus;
      save(value: FeishuOfficeUpdate): Promise<void>;
      check(): Promise<void>;
      setResident(enabled: boolean): void;
    };
  }
}
