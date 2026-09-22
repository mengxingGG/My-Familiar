import type { McpConfig } from "../../packages/contracts/index.ts";

// 按官方工具清单明确列出业务能力；新增未知工具不会自动获得账户管理能力。
// 来源：https://github.com/github/github-mcp-server（2026-09-22）
const businessWrites = new Set(
  `
actions_run_trigger assign_copilot_to_issue request_copilot_review create_repository_ruleset custom_properties_write
assign_copilot_to_issue_with_intent discussion_comment_write
create_gist update_gist delete_gist add_issue_comment issue_write sub_issue_write
update_issue_comment label_write dismiss_notification manage_notification_subscription
manage_repository_notification_subscription mark_all_notifications_read projects_write
add_comment_to_pending_review add_reply_to_pull_request_comment create_pull_request
merge_pull_request pull_request_review_write update_pull_request update_pull_request_branch
create_branch create_or_update_file create_repository delete_file delete_repository
fork_repository push_files star_repository unstar_repository create_pull_request_with_copilot
create_issue update_issue create_pull_request_review submit_pending_pull_request_review
delete_pending_pull_request_review create_pending_pull_request_review
`
    .trim()
    .split(/\s+/),
);
const businessReads = new Set(
  `
actions_get actions_list get_job_logs get_code_quality_finding get_code_scanning_alert
check_dependency_vulnerabilities run_secret_scanning semantic_issue_similarity_search
list_code_scanning_alerts get_me get_team_members get_teams get_dependabot_alert
list_dependabot_alerts get_discussion get_discussion_comments list_discussion_categories
list_discussions get_gist list_gists get_repository_tree custom_properties_read
repository_ruleset_read get_label issue_read list_issue_fields list_issue_types list_issues
search_issues list_label get_notification_details list_notifications search_orgs
projects_get projects_list list_pull_requests pull_request_read search_pull_requests
get_commit get_file_contents get_latest_release get_release_by_tag get_tag list_branches
list_commits list_releases list_repository_collaborators list_tags search_code search_commits
search_repositories get_secret_scanning_alert list_secret_scanning_alerts
get_global_security_advisory list_global_security_advisories list_org_repository_security_advisories
list_repository_security_advisories list_starred_repositories search_users get_copilot_space
list_copilot_spaces github_support_docs_search get_issue get_issue_comments get_pull_request
get_pull_request_comments get_pull_request_reviews get_pull_request_files get_pull_request_status
`
    .trim()
    .split(/\s+/),
);
export function isOfficialGithub(c: McpConfig) {
  return (
    c.transport === "http" &&
    [
      "https://api.githubcopilot.com/mcp/",
      "https://api.githubcopilot.com/mcp/readonly",
    ].includes(c.url ?? "")
  );
}
export function githubBusinessSchema(
  name: string,
  schema: Record<string, unknown>,
) {
  if (!["create_repository_ruleset", "custom_properties_write"].includes(name))
    return schema;
  const copy = structuredClone(schema);
  const properties = (copy.properties ?? {}) as Record<string, unknown>;
  copy.properties = {
    ...properties,
    level: {
      type: "string",
      const: "repository",
      description: "仅允许单仓库；组织或企业级管理不开放",
    },
  };
  copy.required = [
    ...new Set([
      ...(Array.isArray(copy.required) ? copy.required : []),
      "level",
    ]),
  ];
  return copy;
}
export function guardGithubBusinessArgs(
  name: string,
  args: Record<string, unknown>,
) {
  if (
    ["create_repository_ruleset", "custom_properties_write"].includes(name) &&
    (args.level !== "repository" ||
      args.org !== undefined ||
      args.enterprise !== undefined)
  )
    throw new Error("组织与企业账户管理暂不开放；此工具仅支持单仓库操作");
}
export function githubToolAccess(
  c: McpConfig,
  name: string,
): "read" | "write" | false | undefined {
  if (!isOfficialGithub(c)) return undefined;
  if (businessReads.has(name)) return "read";
  if (businessWrites.has(name) && !c.url!.endsWith("/readonly")) return "write";
  return false;
}
