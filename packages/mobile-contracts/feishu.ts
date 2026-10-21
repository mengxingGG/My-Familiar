import type { FeishuChannelStatus, FeishuChannelUpdate } from "../contracts/feishu-channel.ts";
import type { FeishuOfficeStatus, FeishuOfficeUpdate } from "../contracts/feishu-office.ts";
import type { FeishuAuthStatus, FeishuAuthBegin } from "../contracts/feishu-auth.ts";
export type MobileFeishuStatus = FeishuChannelStatus & { office?: FeishuOfficeStatus; auth?: FeishuAuthStatus };
export interface MobileFeishuCommands {
  "feishu.status": { params: undefined; result: MobileFeishuStatus };
  "feishu.save": { params: FeishuChannelUpdate; result: MobileFeishuStatus };
  "feishu.pair": { params: { revision: string }; result: MobileFeishuStatus };
  "feishu.stop": { params: undefined; result: MobileFeishuStatus };
  "feishu.office.save": { params: FeishuOfficeUpdate; result: MobileFeishuStatus };
  "feishu.office.check": { params: undefined; result: MobileFeishuStatus };
  "feishu.auth.begin": { params: FeishuAuthBegin; result: MobileFeishuStatus };
  "feishu.auth.open": { params: { revision: string }; result: MobileFeishuStatus };
  "feishu.auth.cancel": { params: { revision: string }; result: MobileFeishuStatus };
  "feishu.auth.forget": { params: { revision: string }; result: MobileFeishuStatus };
}
