import type { FeishuSettings } from "../../packages/contracts/index.ts";
import { guardOfficeAccount } from "./policy.ts";
export const feishuDefaults: FeishuSettings = {
  officeEnabled: false,
  channelEnabled: false,
  identity: "user",
  allowedUsers: [],
};
export function validateFeishu(value: FeishuSettings): FeishuSettings {
  if (
    !value ||
    typeof value.officeEnabled !== "boolean" ||
    typeof value.channelEnabled !== "boolean" ||
    !["user", "bot"].includes(value.identity) ||
    !Array.isArray(value.allowedUsers) ||
    value.allowedUsers.length > 20 ||
    value.allowedUsers.some(
      (id) => typeof id !== "string" || !/^ou_[a-zA-Z0-9_-]{1,100}$/.test(id),
    )
  )
    throw new Error("飞书设置无效，用户 ID 应为 ou_ 开头的 open_id");
  return {
    officeEnabled: value.officeEnabled,
    channelEnabled: value.channelEnabled,
    identity: value.identity,
    allowedUsers: [...new Set(value.allowedUsers)],
  };
}
export function validateOfficeArgs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 60 ||
    value.some(
      (a) => typeof a !== "string" || a.length > 32000 || a.includes("\0"),
    )
  )
    throw new Error("CLI 参数应为字符串数组");
  if (value.length === 1 && ["--help", "-h"].includes(value[0]))
    return ["--help"];
  if (
    ![
      "calendar",
      "docs",
      "drive",
      "sheets",
      "base",
      "bitable",
      "task",
      "im",
      "wiki",
      "contact",
      "mail",
      "vc",
      "minutes",
      "board",
      "markdown",
      "approval",
      "attendance",
      "okr",
      "slides",
      "apps",
      "whiteboard",
      "mindnotes",
      "note",
      "schema",
      "skills",
    ].includes(value[0])
  )
    throw new Error(
      "此工具只用于飞书办公命令；登录、配置和事件订阅请在插件设置中处理",
    );
  if (value.some((a) => /^--as(?:=|$)/.test(a)))
    throw new Error(
      "身份由“飞书与 GitHub → 以谁的身份操作”设置统一附加；请移除 --as 及其值后重试，需要切换身份时在设置中修改",
    );
  if (
    value[0] === "skills" &&
    (value.length !== 3 ||
      value[1] !== "read" ||
      !/^lark-[a-z0-9/._-]+$/.test(value[2]) ||
      value[2].includes(".."))
  )
    throw new Error("这里只能读取 CLI 自带的飞书 Skill 说明");
  if (
    value.some((a) =>
      /^--(?:app|app-id|app-secret|app-secret-stdin|token|access-token|user-access-token|config|profile|credential|credential-provider|plugin|plugins|plugin-dir|endpoint|base-url|domain)(?:=|$)/.test(
        a,
      ),
    )
  )
    throw new Error("不能通过办公工具覆盖身份、凭据或账户配置");
  guardOfficeAccount(value);
  return value.slice();
}
export function incomingMessage(value: unknown) {
  const e = value as Record<string, unknown>;
  if (
    !e ||
    e.type !== "im.message.receive_v1" ||
    e.sender_type !== "user" ||
    e.chat_type !== "p2p" ||
    e.message_type !== "text" ||
    typeof e.content !== "string" ||
    !e.content.trim() ||
    e.content.length > 8000 ||
    typeof e.sender_id !== "string" ||
    !/^ou_[\w-]+$/.test(e.sender_id) ||
    typeof e.message_id !== "string" ||
    !/^om_[\w-]+$/.test(e.message_id) ||
    typeof e.chat_id !== "string" ||
    !/^oc_[\w-]+$/.test(e.chat_id)
  )
    return undefined;
  return {
    sender: e.sender_id,
    chat: e.chat_id,
    id: e.message_id,
    text: e.content.trim(),
  };
}
