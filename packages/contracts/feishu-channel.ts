export interface FeishuChannelConfig {
  appId: string;
  enabled: boolean;
  allowedUsers: string[];
}
export interface FeishuChannelStatus extends FeishuChannelConfig {
  revision: string;
  hasSecret: boolean;
  phase: "off" | "waiting" | "connecting" | "connected" | "reconnecting" | "error";
  detail: string;
  pending: number;
  pairing?: { code: string; expires: number };
}
export interface FeishuChannelUpdate extends FeishuChannelConfig {
  revision: string;
  appSecret?: string;
  clearSecret?: boolean;
}
declare module "../kernel/index.ts" {
  interface Events { "feishu.channel.changed": FeishuChannelStatus; }
  interface Services {
    "feishu.channel": {
      status(): FeishuChannelStatus;
      save(input: FeishuChannelUpdate): Promise<FeishuChannelStatus>;
      pair(revision: string): Promise<FeishuChannelStatus>;
      stop(): Promise<FeishuChannelStatus>;
      /** 常驻入口立即取消连接与当前任务，暂停不改写用户开启偏好。 */
      setResident(enabled: boolean): void;
    };
  }
}
