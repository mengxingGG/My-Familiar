import { access } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { definePlugin } from "../../packages/contracts/index.ts";
import type { FeishuOfficeStatus } from "../../packages/contracts/feishu-office.ts";
import { channelSecretScope } from "../feishu-channel/index.ts";
import { validateOfficeArgs } from "../feishu-cli/validation.ts";
import { officeCommand, officeHelp } from "../feishu-cli/policy.ts";
import { missingAccess, accessHint } from "../feishu-cli/access.ts";
import { managedFeishuRunner, type ManagedFeishuRequest, type ManagedFeishuResult } from "./runner.ts";
import { tenantTokenClient } from "./token.ts";
import { wasmFeishuRunner, type WasmFeishuOptions } from './wasm-runner.ts';

export interface AndroidFeishuOfficeOptions {
  executable?: string;
  execute?: (input: ManagedFeishuRequest, signal: AbortSignal) => Promise<ManagedFeishuResult>;
  fetcher?: typeof fetch;
  resident?: () => Promise<boolean>;
  wasm?: Pick<WasmFeishuOptions,'assets'|'addon'|'timeoutMs'|'fetcher'|'createWorker'>;
}
const local = (args: string[]) => officeHelp(args) || ["schema", "skills"].includes(args[0]);

/** 办公工具复用共享 Agent 权限；原生 CLI 只接受此插件已经确定的身份和工作区。 */
export function androidFeishuOffice(options: AndroidFeishuOfficeOptions = {}) {
  return definePlugin({
    manifest: { manifestVersion: 1, id: "familiar.feishu-office-android", version: "0.1.0", provides: ["feishu.office"],
      requires: ["familiar.home", "storage.local", "secrets.local", "feishu.channel", "feishu.auth", "agent.tools"], permissions: ["process.feishu", "network.feishu"] },
    async start(ctx) {
      ctx.require("process.feishu"); ctx.require("network.feishu");
      const store = ctx.use("storage.local"), channel = ctx.use("feishu.channel"), secrets = ctx.use("secrets.local");
      const auth = ctx.use("feishu.auth");
      const workspace = join(ctx.use("familiar.home").root, "workspace");
      const privateRoot = join(ctx.use("familiar.home").root, "plugins", "feishu-office");
      const installed = !!options.execute || (options.wasm ? (await Promise.all([options.wasm.addon,...['worker.cjs','filesystem.cjs','wasm_exec.js','official-cli.wasm'].map(name=>join(options.wasm!.assets,name))].map(file=>access(file).then(()=>true,()=>false)))).every(Boolean) : !!options.executable && await access(options.executable).then(() => true, () => false));
      const run = options.execute ?? (installed ? options.wasm ? wasmFeishuRunner({...options.wasm,workspace,configuration:join(privateRoot,'config'),temporary:join(privateRoot,'tmp')}) : managedFeishuRunner({ executable: options.executable!, workspace, configuration: join(privateRoot, "config"), temporary: join(privateRoot, "tmp") }) : undefined);
      let saved = await store.read("feishu-office", { enabled: false, revision: randomUUID() as string, appId: "", identity: "bot" as "bot" | "user" });
      saved.identity ??= "bot";
      if (typeof saved.enabled !== "boolean" || typeof saved.revision !== "string" || typeof saved.appId !== "string" || !["bot", "user"].includes(saved.identity)) throw Error("INVALID_INPUT");
      const tokens = tenantTokenClient(options.fetcher);
      let current = new AbortController(), disposeTool: (() => void) | undefined, pending = 0, checking = false;
      let resident = installed && (options.resident ? await options.resident().catch(() => false) : true);
      let detail = "办公能力未开启。", checkedAt: number | undefined, queue = Promise.resolve();
      let missingScopes: string[] = [];
      const authKey = () => { const s = auth.status(); return JSON.stringify([s.revision, s.connected, s.user?.id]); };
      let lastAuthKey = authKey();
      const ready = () => installed && saved.enabled && resident && saved.appId === channel.status().appId && channel.status().hasSecret && (saved.identity === "bot" || auth.status().connected);
      const status = (): FeishuOfficeStatus => ({ enabled: saved.enabled, revision: saved.revision, appId: saved.appId, identity: saved.identity, available: installed, checking, pending, detail, ...(missingScopes.length ? { missingScopes: [...missingScopes] } : {}), ...(checkedAt ? { checkedAt } : {}) });
      const refresh = () => {
        current.abort(); current = new AbortController(); tokens.clear(); disposeTool?.(); disposeTool = undefined;
        missingScopes = [];
        detail = !installed ? "此安装包缺少办公执行器。" : !saved.enabled ? "办公能力未开启。" : !resident ? "等待开启常驻伙伴。" : saved.identity === "user" && !auth.status().connected ? "请先完成个人账号登录。" : !ready() ? "应用或密钥已变化，请保存凭据后重新启用办公能力。" : saved.identity === "user" ? "个人办公已开启；使用当前登录用户获准访问的内容。" : "机器人办公已开启；使用应用获准访问的文档、日程和任务等内容。";
        if (!ready()) return;
        const officeSignal = current.signal, appId = saved.appId, revision = saved.revision, identity = saved.identity, user = auth.status();
        const confirmationCommands = new Set<string>();
        const active = (signal: AbortSignal) => AbortSignal.any([signal, officeSignal, ctx.abort.signal]);
        disposeTool = ctx.use("agent.tools").register({
          name: "feishu_cli", description: `飞书办公：使用${identity === "bot" ? "机器人" : "已登录个人账号"}身份查询和处理文档、日程、任务、消息等。先用 --help、schema 或 skills read 查询官方命令。args 是参数数组；省略 --as。业务写入走外部操作权限，文件限于灵伴工作区。失败或结果不确定时不要自动重试写入。身份、登录和补授权只能由用户在设置 → 飞书中操作，工具不能管理账户或切换身份。`,
          parameters: { type: "object", properties: { args: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 60 } }, required: ["args"], additionalProperties: false },
          async permission(input) {
            officeSignal.throwIfAborted(); const args = validateOfficeArgs(input.args); let read = local(args);
            const command = officeCommand(args);
            if (!read && command.length > 0 && command.length <= 4 && command.every(value => /^[a-zA-Z0-9_+.-]+$/.test(value))) {
              const help = await run!({ args: [...command, "--help"], appId: "", identity: "bot" }, active(AbortSignal.timeout(10000)));
              read = help.code === 0 && !help.interrupted && /Risk:\s*read\b/i.test(help.output + help.errors);
              if (help.code === 0 && !help.interrupted && /^\s+--yes\s/m.test(help.output + help.errors)) confirmationCommands.add(command.join(" "));
            }
            officeSignal.throwIfAborted();
            return { category: read ? "read" : "outsideWrite", scope: JSON.stringify([appId, identity, revision, args, ...(identity === "user" ? [user.revision, user.user?.id] : [])]) };
          },
          async execute(input, { signal }) {
            signal = active(signal); signal.throwIfAborted();
            if (pending >= 20) throw Error("飞书办公任务过多，请稍后再试。");
            const args = validateOfficeArgs(input.args); const offline = local(args) || args.includes("--dry-run");
            pending++;
            try {
              const token = offline ? undefined : identity === "user" ? await auth.token(signal) : await tokens.get(appId, secrets.get(channelSecretScope(appId)), signal);
              signal.throwIfAborted();
              // 共享权限已经批准；预先给 CLI 确认标志，避免执行后根据退出码重放。
              if (confirmationCommands.has(officeCommand(args).join(" ")) && !args.includes("--yes")) args.push("--yes");
              const result = await run!({ args, appId, identity, token }, signal);
              if (result.interrupted) {
                if (!officeSignal.aborted) detail = "上次办公执行中断；结果未确认，未自动重试。";
                return { ok: false, interrupted: result.interrupted, outcome: "unknown", error: "执行中断，外部操作可能已发生。先核对目标内容，再决定是否重试。" };
              }
              if (result.code !== 0) {
                if (!officeSignal.aborted) detail = "上次办公操作未完成，请查看对话中的原因。";
                const issue = missingAccess(result.errors || result.output, officeCommand(args).join(" "), identity);
                if (issue && identity === "user" && !officeSignal.aborted) missingScopes = issue.scopes;
                return { ok: false, exitCode: result.code, error: result.errors || result.output || "飞书操作未完成。", ...(issue ? { access: issue, hint: identity === "user" ? "请用户打开设置 → 飞书 → 个人账号，确认并补充所列权限后重试。应用未开通的权限还需在飞书开发者后台启用；不要改用机器人绕过授权。" : accessHint(issue) } : {}) };
              }
              if (!officeSignal.aborted) detail = "上次办公命令已完成。";
              return result.output || result.errors;
            } catch (error) {
              if (!officeSignal.aborted) detail = "办公身份或执行器不可用，请检查应用密钥、网络和应用授权。";
              signal.throwIfAborted(); throw Error(error instanceof Error && error.message === "FEISHU_USER_REQUIRED" ? "请在设置 → 飞书中重新登录个人账号；未发出办公命令。" : error instanceof Error && error.message === "FEISHU_AUTH_FAILED" ? "飞书机器人认证失败，请检查应用密钥和网络。" : "飞书执行未确认，请先核对目标内容。");
            } finally { pending--; }
          },
        });
      };
      ctx.provide("feishu.office", {
        status,
        save(value) {
          const task = queue.then(async () => {
            if (typeof value.enabled !== "boolean" || typeof value.revision !== "string" || typeof value.channelRevision !== "string" || value.identity !== undefined && !["bot", "user"].includes(value.identity)) throw Error("INVALID_INPUT");
            const account = channel.status();
            if (value.revision !== saved.revision || value.channelRevision !== account.revision) throw Error("CONFLICT");
            if (value.enabled && (!installed || !account.appId || !account.hasSecret)) throw Error("UNAVAILABLE");
            const next = { enabled: value.enabled, revision: randomUUID(), appId: account.appId, identity: value.identity ?? saved.identity };
            await store.write("feishu-office", next); saved = next; refresh();
          });
          queue = task.then(() => {}, () => {}); return task;
        },
        async check() {
          if (!run) throw Error("UNAVAILABLE"); if (checking || pending) throw Error("CONFLICT");
          checking = true;
          try {
            const result = await run({ args: ["--help"], appId: "", identity: "bot" }, AbortSignal.any([ctx.abort.signal, AbortSignal.timeout(12000)]));
            checkedAt = Date.now(); detail = result.code === 0 && !result.interrupted ? "内置办公执行器可用；本次检查未连接飞书，也未验证账号授权。" : "办公执行器检查失败，尚未连接飞书。";
          } finally { checking = false; }
        },
        setResident(enabled) { resident = enabled; refresh(); },
      });
      ctx.on("feishu.channel.changed", refresh);
      ctx.on("feishu.auth.changed", () => { const key = authKey(); if (key !== lastAuthKey) { lastAuthKey = key; if (saved.identity === "user") refresh(); } });
      ctx.on("secrets.changed", scope => { if (typeof scope === "string" && scope.startsWith("feishu-channel:")) refresh(); });
      ctx.effect(async () => { current.abort(); disposeTool?.(); tokens.clear(); await queue; });
      refresh();
    },
  });
}
