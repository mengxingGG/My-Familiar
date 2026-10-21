import type { Kernel } from "../../../packages/kernel/index.ts";
import type { FeishuChannelUpdate, FeishuOfficeUpdate, FeishuAuthBegin } from "../../../packages/contracts/index.ts";
export function mobileFeishu(kernel: Kernel) {
  const channel = kernel.resolve("feishu.channel");
  const office = kernel.resolve("feishu.office");
  const auth = kernel.resolve("feishu.auth");
  const status = () => ({ ...channel.status(), office: office.status(), auth: auth.status() });
  return async (method: string, params: Record<string, unknown> = {}) => {
    const allowed = method === "feishu.save" ? ["appId", "enabled", "allowedUsers", "revision", "appSecret", "clearSecret"] : method === "feishu.pair" || ["feishu.auth.open", "feishu.auth.cancel", "feishu.auth.forget"].includes(method) ? ["revision"] : method === "feishu.auth.begin" ? ["revision", "channelRevision", "scopes"] : method === "feishu.office.save" ? ["enabled", "revision", "channelRevision", "identity"] : [];
    if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key))) throw Error("INVALID_INPUT");
    if (method === "feishu.status") return status();
    if (method === "feishu.auth.begin") { await auth.begin(params as unknown as FeishuAuthBegin); return status(); }
    if (["feishu.auth.open", "feishu.auth.cancel", "feishu.auth.forget"].includes(method)) {
      if (typeof params.revision !== "string") throw Error("INVALID_INPUT");
      if (method === "feishu.auth.open") await auth.open(params.revision);
      if (method === "feishu.auth.cancel") auth.cancel(params.revision);
      if (method === "feishu.auth.forget") await auth.forget(params.revision);
      return status();
    }
    if (method === "feishu.stop") { await channel.stop(); return status(); }
    if (method === "feishu.office.save") { await office.save(params as unknown as FeishuOfficeUpdate); return status(); }
    if (method === "feishu.office.check") { await office.check(); return status(); }
    if (method === "feishu.pair") {
      if (typeof params.revision !== "string") throw Error("INVALID_INPUT");
      await channel.pair(params.revision); return status();
    }
    if (method === "feishu.save") { await channel.save(params as unknown as FeishuChannelUpdate); return status(); }
    throw Error("UNAVAILABLE");
  };
}
