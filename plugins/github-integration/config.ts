import type { McpConfig } from "../../packages/contracts/index.ts";

/** 两种模式固定使用 GitHub 官方服务；供桌面和移动端共用。 */
export function githubConfig(readOnly: boolean, enabled = false): McpConfig {
  return {
    id: "github", name: "GitHub 官方", transport: "http",
    url: "https://api.githubcopilot.com/mcp/" + (readOnly ? "readonly" : ""),
    enabled, auth: { kind: "header", name: "Authorization", prefix: "Bearer " },
  };
}
export function isGithubConfig(c: McpConfig): boolean {
  return c.id === "github" && c.transport === "http" &&
    [githubConfig(true).url, githubConfig(false).url].includes(c.url) &&
    c.auth?.kind === "header" && c.auth.name === "Authorization" && c.auth.prefix === "Bearer ";
}
