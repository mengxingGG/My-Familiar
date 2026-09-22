import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import {
  definePlugin,
  type FeishuSettings,
  type FeishuAccessIssue,
} from "../../packages/contracts/index.ts";
import {
  dependencies,
  installDependency,
  exists,
  startCli,
  cliEnvironment,
  redact,
} from "../cli-dependencies/index.ts";
import { jobs } from "../cli-dependencies/jobs.ts";
import {
  feishuDefaults,
  validateFeishu,
  validateOfficeArgs,
  incomingMessage,
} from "./validation.ts";
import { missingAccess, accessHint } from "./access.ts";
import { officeCommand, officeHelp, officeLoginArgs } from "./policy.ts";

export function feishuCli(
  openExternal: (url: string) => Promise<void> = async () => {},
  launch: typeof startCli = startCli,
) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: "familiar.feishu",
      version: "0.1.0",
      provides: ["feishu.cli"],
      requires: [
        "familiar.home",
        "storage.local",
        "agent.tools",
        "agent.approvals",
        "channel.chat",
      ],
      permissions: ["process.feishu", "network.dependencies"],
    },
    async start(ctx) {
      ctx.require("process.feishu");
      ctx.require("network.dependencies");
      const root = join(ctx.use("familiar.home").root, "plugins", "feishu"),
        bin = join(root, "bin"),
        exe = join(bin, dependencies.feishu.executable),
        store = ctx.use("storage.local");
      const env = cliEnvironment({
        LARKSUITE_CLI_CONFIG_DIR: join(root, "config"),
      });
      await mkdir(root, { recursive: true });
      let config = validateFeishu(
          await store.read("feishu-settings", feishuDefaults),
        ),
        disposeTool: (() => void) | undefined;
      let channel = "未启用",
        error: string | undefined,
        lastSender: string | undefined,
        pairing: { code: string; expires: number } | undefined;
      let listener: ReturnType<typeof startCli> | undefined,
        channelAbort: AbortController | undefined,
        generation = 0,
        pending = 0;
      let messageQueue = Promise.resolve(),
        configQueue = Promise.resolve();
      let saving = false;
      let officeAbort = new AbortController();
      const accessIssues = new Map<string, FeishuAccessIssue>();
      const job = jobs(ctx.abort.signal),
        seen = new Set(await store.read<string[]>("feishu-seen", []));
      const execute = (
        args: string[],
        signal: AbortSignal,
        stdin?: string,
        output?: (text: string) => void,
        timeout = 60000,
      ) =>
        launch(exe, args, {
          cwd: root,
          env,
          signal,
          stdin,
          timeout,
          onStdout: output,
          onStderr: output,
        }).done;
      const requireInstalled = async () => {
        if (!(await exists(exe))) throw new Error("请先点击“安装飞书依赖”");
      };
      const checked = async (...args: Parameters<typeof execute>) => {
        const r = await execute(...args);
        if (r.code !== 0)
          throw new Error(
            redact(r.errors || r.output || `飞书 CLI 退出码 ${r.code}`),
          );
        return r;
      };
      const saveUsers = (sender: string) => {
        const task = configQueue.then(async () => {
          config = {
            ...config,
            allowedUsers: [...new Set([...config.allowedUsers, sender])],
          };
          await store.write("feishu-settings", config);
        });
        configQueue = task.catch(() => {});
        return task;
      };
      const reply = async (
        messageId: string,
        text: string,
        signal: AbortSignal,
      ) => {
        // 直接回复触发消息；明确的私聊收件人不交给模型选择。
        const chunks = Array.from(text).reduce<string[]>((all, c, i) => {
          const n = Math.floor(i / 2500);
          all[n] = (all[n] ?? "") + c;
          return all;
        }, []);
        for (let i = 0; i < chunks.length; i++)
          await checked(
            [
              "im",
              "+messages-reply",
              "--message-id",
              messageId,
              "--text",
              chunks[i],
              "--idempotency-key",
              createHash("sha256")
                .update(messageId + ":" + i)
                .digest("hex")
                .slice(0, 32),
              "--as",
              "bot",
            ],
            signal,
          );
      };
      const handleMessage = async (value: unknown, signal: AbortSignal) => {
        const message = incomingMessage(value);
        if (!message || seen.has(message.id)) return;
        lastSender = message.sender;
        if (!config.allowedUsers.includes(message.sender)) {
          if (
            !pairing ||
            Date.now() > pairing.expires ||
            message.text !== "/pair " + pairing.code
          )
            return;
          seen.add(message.id);
          await store.write("feishu-seen", [...seen]);
          await saveUsers(message.sender);
          pairing = undefined;
          await reply(
            message.id,
            "配对成功，我在这里。现在可以直接和我聊天了。",
            signal,
          );
          return;
        }
        signal.throwIfAborted();
        seen.add(message.id);
        while (seen.size > 2000) seen.delete(seen.values().next().value!);
        // 处理前持久化去重，崩溃后不重放可能有外部副作用的任务。
        await store.write("feishu-seen", [...seen]);
        const id = "feishu:" + message.sender + ":" + message.chat;
        let answer: string;
        try {
          if (message.text === "/new") {
            await ctx.use("channel.chat").clear(id);
            answer = "新的对话开始了，记忆仍然保留。";
          } else
            answer = await ctx
              .use("channel.chat")
              .reply(id, message.text, signal);
        } catch (e) {
          signal.throwIfAborted();
          answer =
            "这次没能完成：" +
            redact(e instanceof Error ? e.message : "未知错误");
        }
        await reply(message.id, answer, signal);
      };
      const stopChannel = async () => {
        generation++;
        channelAbort?.abort();
        listener?.stop();
        await listener?.done.catch(() => {});
        listener = undefined;
        await messageQueue;
        channel = "未启用";
        // 独立配置目录的总线由本插件管理，不停止用户其他 CLI 实例。
        if (await exists(exe))
          await execute(["event", "stop"], AbortSignal.timeout(10000)).catch(
            () => {},
          );
      };
      const startChannel = async () => {
        if (!config.channelEnabled || listener || !ctx.active) return;
        await requireInstalled();
        channel = "正在连接";
        error = undefined;
        const current = ++generation;
        channelAbort = new AbortController();
        const signal = AbortSignal.any([channelAbort.signal, ctx.abort.signal]);
        let stdout = "",
          stderr = "";
        const processLine = (line: string) => {
          if (pending >= 20) {
            error = "待回复消息过多，部分新消息未接收，请稍后重发";
            return;
          }
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            error = "飞书事件格式无法识别";
            return;
          }
          pending++;
          messageQueue = messageQueue
            .then(async () => {
              if (current === generation && !signal.aborted)
                await handleMessage(value, signal);
            })
            .catch((e) => {
              if (!signal.aborted)
                error = redact(e instanceof Error ? e.message : "消息处理失败");
            })
            .finally(() => {
              pending--;
            });
        };
        listener = launch(
          exe,
          ["event", "consume", "im.message.receive_v1", "--as", "bot"],
          {
            cwd: root,
            env,
            signal,
            keepStdin: true,
            timeout: 0,
            onStdout(chunk) {
              stdout += chunk;
              if (stdout.length > 256000) {
                error = "飞书事件过大，连接已停止";
                channelAbort?.abort();
                return;
              }
              const lines = stdout.split("\n");
              stdout = lines.pop()!;
              for (const line of lines) if (line.trim()) processLine(line);
            },
            onStderr(chunk) {
              stderr = (stderr + chunk).slice(-8000);
              if (
                stderr.includes("[event] ready event_key=im.message.receive_v1")
              )
                channel = "已连接";
            },
          },
        );
        void listener.done
          .then((r) => {
            if (current === generation) {
              channel = "连接已断开";
              error = redact(
                r.errors || `事件订阅退出（${r.code}），请检查授权后重新启用`,
              );
            }
          })
          .catch((e) => {
            if (current === generation) {
              channel = "连接已断开";
              error = e.message;
            }
          })
          .finally(() => {
            if (current === generation) listener = undefined;
          });
      };
      const refreshTool = () => {
        officeAbort.abort();
        officeAbort = new AbortController();
        disposeTool?.();
        disposeTool = undefined;
        if (!config.officeEnabled) return;
        const officeSignal = officeAbort.signal,
          identity = config.identity;
        disposeTool = ctx.use("agent.tools").register({
          name: "feishu_cli",
          description: `通过飞书官方 CLI 读取、创建、修改、删除文档、日程、任务和消息等业务内容；业务操作默认允许，CLI 确认由插件在工具权限通过后处理，无需额外确认。账户、组织、凭据和安全设置不开放。args 为参数数组；可用 ["--help"]、["docs","--help"]、schema 或 skills read 查看说明。当前身份为 ${identity}，插件统一附加 --as，请省略示例中的 --as 及其值。auth/config/事件订阅由“设置 → 飞书与 GitHub”管理；缺权限时按返回的授权提示处理。`,
          parameters: {
            type: "object",
            properties: {
              args: {
                type: "array",
                items: { type: "string" },
                minItems: 1,
                maxItems: 60,
              },
            },
            required: ["args"],
            additionalProperties: false,
          },
          async permission(input) {
            officeSignal.throwIfAborted();
            const args = validateOfficeArgs(input.args);
            await requireInstalled();
            const command = officeCommand(args);
            let read =
              officeHelp(args) || args[0] === "schema" || args[0] === "skills";
            if (
              !read &&
              command.every((a) => /^[a-zA-Z0-9_+.-]+$/.test(a)) &&
              command.length <= 4
            ) {
              const help = await execute(
                [...command, "--help"],
                AbortSignal.any([ctx.abort.signal, AbortSignal.timeout(10000)]),
              );
              read =
                help.code === 0 &&
                /Risk:\s*read\b/i.test(help.output + help.errors);
            }
            return {
              category: read ? "read" : "write",
              scope: JSON.stringify([identity, args]),
            };
          },
          async execute(input, { signal }) {
            signal = AbortSignal.any([signal, officeSignal, ctx.abort.signal]);
            signal.throwIfAborted();
            const args = validateOfficeArgs(input.args);
            const command = officeCommand(args).join(" ");
            const help = officeHelp(args);
            const accessKey = identity + ":" + command;
            if (!help && !["schema", "skills"].includes(args[0]))
              args.push("--as", identity);
            let result = await execute(args, signal);
            if (result.code === 10) {
              let confirmation;
              try {
                confirmation = JSON.parse(result.errors || result.output);
              } catch {}
              // agent.tools 已执行用户的读写策略；业务操作不再重复请求确认。
              if (
                confirmation?.error?.type === "confirmation_required" &&
                !args.includes("--yes")
              ) {
                signal.throwIfAborted();
                result = await execute([...args, "--yes"], signal);
              }
            }
            if (result.code !== 0) {
              const issue = missingAccess(
                result.errors || result.output,
                command,
                identity,
              );
              if (issue && !signal.aborted) accessIssues.set(accessKey, issue);
              return {
                ok: false,
                exitCode: result.code,
                error: issue
                  ? `飞书${identity === "user" ? "用户" : "机器人"}缺少权限：${issue.scopes.join(" ")}`
                  : redact(result.errors || result.output),
                ...(issue ? { access: issue, hint: accessHint(issue) } : {}),
              };
            }
            if (!help && !args.includes("--dry-run") && !signal.aborted)
              accessIssues.delete(accessKey);
            return redact(result.output || result.errors);
          },
        });
      };
      const startJob = async (
        kind: string,
        task: (
          signal: AbortSignal,
          append: (text: string) => void,
        ) => Promise<void>,
      ) => {
        await requireInstalled();
        job.start(kind, task);
      };
      ctx.provide("feishu.cli", {
        status: async () => ({
          config: structuredClone(config),
          root,
          installed: await exists(exe),
          version: dependencies.feishu.version,
          job: job.state(),
          channel,
          error,
          accessIssues: structuredClone([...accessIssues.values()]),
          lastSender,
          pairing:
            pairing && Date.now() < pairing.expires
              ? { ...pairing }
              : undefined,
        }),
        async save(input) {
          const next = validateFeishu(input);
          if (next.channelEnabled || next.officeEnabled)
            await requireInstalled();
          if (saving || job.busy()) throw new Error("请等待当前保存或登录完成");
          saving = true;
          try {
            await stopChannel();
            const task = configQueue.then(async () => {
              await store.write("feishu-settings", next);
              config = next;
              refreshTool();
              await startChannel();
            });
            configQueue = task.catch(() => {});
            await task;
          } finally {
            saving = false;
          }
        },
        async install() {
          if (listener) throw new Error("请先停用聊天通道再安装依赖");
          job.start("安装飞书依赖", async (signal, append) => {
            await installDependency("feishu", bin, signal, append);
            refreshTool();
          });
        },
        async configure(appId, appSecret) {
          if (
            !/^cli_[A-Za-z0-9_-]{1,100}$/.test(appId) ||
            typeof appSecret !== "string" ||
            !appSecret.trim() ||
            appSecret.length > 4096 ||
            /[\r\n]/.test(appSecret)
          )
            throw new Error("请填写有效的 App ID 和 App Secret");
          if (listener) throw new Error("请先停用聊天通道，再更换机器人");
          await startJob("连接已有机器人", async (signal, append) => {
            await checked(
              [
                "config",
                "init",
                "--app-id",
                appId,
                "--app-secret-stdin",
                "--brand",
                "feishu",
              ],
              signal,
              appSecret + "\n",
            );
            accessIssues.clear();
            append(
              "机器人凭据已交给飞书 CLI 保存。接下来可以登录用户或启用聊天通道。",
            );
          });
        },
        async createApp() {
          await startJob("飞书登录", async (signal, append) => {
            const status = await execute(["auth", "status", "--json"], signal);
            let configured = false;
            try {
              configured = !!JSON.parse(status.output).appId;
            } catch {}
            if (!configured) {
              if (listener)
                throw new Error("请先停用聊天通道，再连接新的飞书应用");
              await checked(
                ["config", "init", "--new"],
                signal,
                undefined,
                append,
                600000,
              );
            }
            append("\n应用已连接，继续完成用户登录授权。\n");
            await checked(officeLoginArgs(), signal, undefined, append, 600000);
            append(
              "\n飞书登录完成，可以保存并启用办公能力；聊天通道请先完成机器人事件配置和配对。",
            );
          });
        },
        async authorize(scope) {
          if (
            typeof scope !== "string" ||
            !/^[a-zA-Z0-9_:., -]{1,3000}$/.test(scope)
          )
            throw new Error("请填写需要授权的 scope，多个用空格分隔");
          await startJob("飞书用户登录", async (signal, append) => {
            await checked(
              ["auth", "login", "--scope", scope],
              signal,
              undefined,
              append,
              600000,
            );
            append("\n用户授权完成。");
          });
        },
        async authorizeOffice() {
          if (config.identity === "bot")
            throw new Error(
              "机器人请在飞书开发者后台开通业务权限，不需要用户 OAuth",
            );
          await startJob("授权飞书办公读写能力", async (signal, append) => {
            await checked(officeLoginArgs(), signal, undefined, append, 600000);
            append("\n办公读写授权完成，账户与组织管理仍不向宠物开放。");
          });
        },
        async check() {
          await startJob("检查飞书登录", async (signal, append) => {
            const r = await checked(
              ["auth", "status", "--json", "--verify"],
              signal,
            );
            append(redact(r.output));
          });
        },
        cancelJob: () => job.cancel(),
        pair() {
          if (!config.channelEnabled) throw new Error("请先启用聊天通道");
          pairing = {
            code: randomBytes(5).toString("hex").toUpperCase(),
            expires: Date.now() + 300000,
          };
        },
        async openAuthorization() {
          const url = job.state()?.url;
          if (!url) throw new Error("当前没有待完成的登录链接");
          await openExternal(url);
        },
      });
      refreshTool();
      if (config.channelEnabled)
        ctx.timeout(
          () =>
            startChannel().catch((e) => {
              channel = "连接失败";
              error = e.message;
            }),
          300,
        );
      ctx.effect(async () => {
        officeAbort.abort();
        await job.cancel();
        await stopChannel();
        await configQueue;
        disposeTool?.();
      });
    },
  });
}
