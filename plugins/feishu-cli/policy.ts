// 业务域授权不包含 application（应用管理）、contact（账户/组织管理）。
// 联系人查询仍可按需补充只读 scope，不使用 --domain all 扩大到账户管理。
export const officeDomains = [
  "approval",
  "apps",
  "attendance",
  "base",
  "calendar",
  "docs",
  "drive",
  "im",
  "mail",
  "markdown",
  "mindnotes",
  "minutes",
  "note",
  "okr",
  "sheets",
  "slides",
  "task",
  "vc",
  "wiki",
];
export const officeLoginArgs = () => [
  "auth",
  "login",
  "--domain",
  officeDomains.join(","),
];
export function officeCommand(args: string[]) {
  const end = args.findIndex((a) => a.startsWith("-"));
  return args.slice(0, end < 0 ? args.length : end);
}
export function officeHelp(args: string[]) {
  // 只识别纯帮助调用，避免把 --content 后面的 "--help" 文本误认为帮助开关。
  return (
    ["--help", "-h"].includes(args.at(-1) ?? "") &&
    args
      .slice(0, -1)
      .every((a) => /^[a-zA-Z0-9_+.-]+$/.test(a) && !a.startsWith("-"))
  );
}
export function guardOfficeAccount(args: string[]) {
  const [domain, resource, method] = args;
  if (
    domain === "contact" &&
    !officeHelp(args) &&
    !(
      ["+get-user", "+search-user", "+search-bot"].includes(resource) ||
      (resource === "user_profiles" && method === "batch_query")
    )
  )
    throw new Error("账户和组织管理暂不开放；通讯录只提供人员与机器人查询");
  if (
    domain === "mail" &&
    !officeHelp(args) &&
    !(
      resource?.startsWith("+") ||
      resource === "multi_entity" ||
      [
        "user_mailbox.drafts",
        "user_mailbox.event",
        "user_mailbox.folders",
        "user_mailbox.labels",
        "user_mailbox.mail_contacts",
        "user_mailbox.message.attachments",
        "user_mailbox.messages",
        "user_mailbox.rules",
        "user_mailbox.sent_messages",
        "user_mailbox.template.attachments",
        "user_mailbox.templates",
        "user_mailbox.threads",
      ].includes(resource) ||
      (resource === "user_mailboxes" &&
        ["accessible_mailboxes", "profile", "search"].includes(method))
    )
  )
    throw new Error(
      "邮箱账户与安全设置暂不开放；可正常处理邮件、草稿、文件夹、规则和模板",
    );
  // 新增管理型快捷命令同样不能绕过资源边界。
  if (
    /^\+(?:account|user-(?:create|delete|update)|password|credential|oauth|security|admin|settings)(?:-|$)/.test(
      resource ?? "",
    )
  )
    throw new Error("账户、凭据和安全设置暂不开放");
}
