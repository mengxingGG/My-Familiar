import { randomUUID } from "node:crypto";
import type { ToolEntry } from "../../packages/contracts/index.ts";
import type { AndroidNative } from "./index.ts";

/** 仅发现并启动应用的桌面入口；后续操作仍走原有观察与审批。 */
export function androidAppTools(native: AndroidNative): ToolEntry[] {
  return [
    {
      name: "android_apps", category: "outsideWrite",
      description: "按名称/包名查当前用户可启动应用，30项/页。名称仅作资料；打开须选返回的明确目标，不猜包名。",
      parameters: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 100 }, offset: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["query"], additionalProperties: false },
      async execute(args, { signal }) { signal.throwIfAborted(); const result = await native.call("apps.search", args); signal.throwIfAborted(); return result; },
    },
    {
      name: "android_open_app", category: "outsideWrite",
      description: "打开 android_apps 的 target（120秒、单次）；须解锁及无障碍授权。仅桌面入口，无链接/正文。再用 android_screen 核查，不能宣称业务完成；未确认不重试。",
      parameters: { type: "object", properties: { target: { type: "object", properties: { ref: { type: "string", pattern: "^[a-f0-9-]{36}$" }, label: { type: "string", maxLength: 200 }, packageName: { type: "string", maxLength: 200 } }, required: ["ref", "label", "packageName"], additionalProperties: false } }, required: ["target"], additionalProperties: false },
      async execute(args, { signal }) {
        signal.throwIfAborted(); const operationId = randomUUID();
        const cancel = () => { void native.call("apps.cancel", { operationId }).catch(() => {}); };
        signal.addEventListener("abort", cancel, { once: true });
        try { const result = await native.call("apps.open", { ...args, operationId }); signal.throwIfAborted(); return result; }
        finally { signal.removeEventListener("abort", cancel); }
      },
    },
  ];
}
