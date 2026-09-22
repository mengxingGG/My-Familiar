import type {
  FeishuAccessIssue,
  FeishuSettings,
} from "../../packages/contracts/index.ts";

// 只从 CLI 明确返回的必需 scope 生成补授权建议，不把“任选其一”合并成全量权限。
export function missingAccess(
  text: string,
  command: string,
  identity: FeishuSettings["identity"],
): FeishuAccessIssue | undefined {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return;
  }
  const error = value?.error;
  if (
    error?.type !== "authorization" ||
    error?.subtype !== "missing_scope" ||
    !Array.isArray(error.missing_scopes) ||
    !error.missing_scopes.length ||
    error.missing_scopes.length > 100 ||
    error.missing_scopes.some(
      (s: unknown) =>
        typeof s !== "string" ||
        !/^[a-zA-Z0-9_.-]+(?::[a-zA-Z0-9_.-]+)+$/.test(s),
    )
  )
    return;
  return {
    command,
    identity,
    scopes: [...new Set<string>(error.missing_scopes)],
  };
}

export function accessHint(issue: FeishuAccessIssue) {
  return issue.identity === "user"
    ? "请用户打开设置 → 飞书与 GitHub → 待补充的授权，点击对应的补充授权按钮并完成官方页面授权，之后重试原命令。若仍提示应用未开通权限，需要在飞书开发者后台启用对应 scope。不要通过办公工具调用 auth/config 或切换成机器人绕过授权。"
    : "当前是机器人身份；请用户在飞书开发者后台为应用开通对应 scope，之后重试原命令。机器人不使用用户 OAuth，不要调用 auth login。";
}
