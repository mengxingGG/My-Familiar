import { _electron as electron } from "playwright/test";
import electronPath from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const root = process.cwd(),
  packaged = process.argv.includes("--packaged"),
  executablePath = packaged
    ? join(root, "release/win-unpacked/Familiar.exe")
    : electronPath,
  baseArgs = packaged ? [] : [root],
  output = resolve(
    `.artifacts/${packaged ? "packaged-" : ""}agent-smoke-` + Date.now(),
  ),
  data = join(output, "user-data");
await mkdir(output, { recursive: true });
const env = { ...process.env, FAMILIAR_DATA_DIR: data };
delete env.ELECTRON_RUN_AS_NODE;
const requests = [];
const mock = createServer(async (req, res) => {
  if (req.url === "/v1/models") {
    await new Promise((r) => setTimeout(r, 400));
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({
        data: [
          { id: "agent-fixture", context_length: 100000 },
          { id: "other-model" },
        ],
      }),
    );
  }
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404);
    return res.end();
  }
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  requests.push(body);
  res.setHeader("Content-Type", "text/event-stream");
  const emit = (v) => res.write("data: " + JSON.stringify(v) + "\n\n");
  const last = body.messages.at(-1);
  let call;
  if (body.messages[0].content.includes("精炼成不超过"))
    emit({
      choices: [
        {
          delta: { content: "# 核心记忆\n- 测试用户喜欢绿茶。" },
          finish_reason: "stop",
        },
      ],
    });
  else if (last.role === "user") {
    if (last.content === "remember")
      call = {
        name: "memory_remember",
        arguments: '{"text":"用户喜欢绿茶。"}',
      };
    if (last.content.startsWith("shell"))
      call = {
        name: "shell_run",
        arguments: JSON.stringify({
          command: "Write-Output 'FAMILIAR_SHELL_OK'",
        }),
      };
    if (last.content === "mcp")
      call = {
        name: body.tools.find((t) => t.function.name.startsWith("mcp_fixture_"))
          .function.name,
        arguments: '{"text":"hello"}',
      };
    if (call)
      emit({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-" + requests.length,
                  type: "function",
                  function: call,
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    else
      emit({
        choices: [
          { delta: { content: "你好，我在这里。" }, finish_reason: "stop" },
        ],
      });
  } else
    emit({
      choices: [
        {
          delta: {
            content: last.content.includes("拒绝")
              ? "好的，这次没有执行。"
              : "完成了，结果已经检查。",
          },
          finish_reason: "stop",
        },
      ],
    });
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
let runtime, controller;
const errors = [];
try {
  runtime = await electron.launch({
    executablePath,
    args: baseArgs,
    env,
  });
  runtime.process().stderr.on("data", (b) => errors.push(b.toString()));
  await runtime.firstWindow();
  controller = await electron.launch({
    executablePath,
    args: [...baseArgs, "--controller"],
    env,
  });
  const page = await controller.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(() => document.body.dataset.connected === "true");
  const request = (name, params) =>
    page.evaluate(({ name, params }) => window.familiar.request(name, params), {
      name,
      params,
    });
  await request("care.set", {
    ...(await request("care.get")).settings,
    enabled: false,
  });
  let config = (await request("runtime.status")).settings;
  config.provider.baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
  config.provider.model = "agent-fixture";
  await request("settings.apply", config);
  await page.locator("[data-page=model]").click();
  await page.waitForFunction(
    (url) => document.querySelector("#base-url").value === url,
    config.provider.baseUrl,
  );
  await page.locator("#load-models").click();
  await page.locator("#temperature").fill("0.4");
  await page.waitForFunction(
    () => !document.querySelector("#load-models").disabled,
  );
  assert.equal(await page.locator("#model-list option").count(), 2);
  console.log("PASS: 获取目录时修改参数不会使列表失效");
  await page.locator("[data-page=memories]").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#memory-file-title").textContent === "CORE.md",
  );
  await page.locator("#memory-editor").fill("用户偏好绿茶。".repeat(600));
  await page.locator("#memory-save").click();
  await page.waitForFunction(
    () =>
      document
        .querySelector("#memory-editor")
        .value.includes("测试用户喜欢绿茶") &&
      !document.querySelector("#memory-save").disabled,
  );
  assert.ok(
    Array.from(await page.locator("#memory-editor").inputValue()).length <=
      3000,
  );
  await page.screenshot({ path: join(output, "memories.png"), fullPage: true });
  console.log("PASS: 管理器编辑记忆、自动精炼、原文保留");
  await page.locator("[data-page=skills]").click();
  await page
    .locator("#skill-content")
    .fill(
      "---\nname: smoke-skill\ndescription: 冒烟验证方法\n---\n先读资料，再说明结果。",
    );
  await page.locator("#skill-install").click();
  await page.waitForFunction(() =>
    document.querySelector("#skills-list").textContent.includes("smoke-skill"),
  );
  const skillRow = page
    .locator("#skills-list .extension-row")
    .filter({ hasText: "smoke-skill" });
  await skillRow.getByRole("button", { name: "停用", exact: true }).click();
  await skillRow.getByRole("button", { name: "启用", exact: true }).waitFor();
  await skillRow.getByRole("button", { name: "查看", exact: true }).click();
  await page.locator("#skill-preview").waitFor({ state: "visible" });
  await page.screenshot({ path: join(output, "skills.png"), fullPage: true });
  console.log("PASS: Skill 粘贴安装、停用及查看");
  await page.locator("[data-page=mcp]").click();
  await page.locator("#mcp-id").fill("fixture");
  await page.locator("#mcp-name").fill("本地测试 MCP");
  await page.locator("#mcp-transport").selectOption("stdio");
  await page.locator("#mcp-command").fill("node");
  await page
    .locator("#mcp-args")
    .fill(resolve("tests/fixtures/mcp-server.cjs"));
  await page.locator("#mcp-auth-name").fill("FIXTURE_KEY");
  await page.locator("#mcp-key").fill("mcp-test-secret");
  await page.locator("#mcp-enabled").check();
  await page.locator("#mcp-save").click();
  await page.waitForFunction(() =>
    document.querySelector("#mcp-list").textContent.includes("已连接 1 个工具"),
  );
  assert.equal(await page.locator("#mcp-key").inputValue(), "");
  assert.doesNotMatch(
    await readFile(join(data, "data/model-secret.json"), "utf8"),
    /mcp-test-secret/,
  );
  await page.screenshot({ path: join(output, "mcp.png"), fullPage: true });
  console.log("PASS: MCP stdio 设置、加密密钥保存、连接和工具目录");
  await request("chat.open");
  const composer = runtime
      .windows()
      .find((w) => w.url().endsWith("composer.html")),
    speech = runtime.windows().find((w) => w.url().endsWith("speech.html"));
  speech.on("pageerror", (e) => errors.push(e.message));
  const send = async (text) => {
    await request("chat.open");
    await composer.locator("#input").fill(text);
    await composer.locator("#send").click();
  };
  const idle = () =>
    speech.waitForFunction(
      () => document.body.dataset.busy === "false",
      {},
      { timeout: 20000 },
    );
  await send("remember");
  await idle();
  assert.match(
    (await request("memory.read", { path: "CORE.md" })).text,
    /用户喜欢绿茶/,
  );
  await send("shell allow");
  await speech.locator("#approval").waitFor({ state: "visible" });
  assert.match(
    await speech.locator("#approval-detail").textContent(),
    /Write-Output/,
  );
  await speech.screenshot({
    path: join(output, "shell-approval.png"),
    omitBackground: true,
  });
  await speech.locator("#allow").click();
  await idle();
  assert.ok(
    requests
      .at(-1)
      .messages.some(
        (m) => m.role === "tool" && m.content.includes("FAMILIAR_SHELL_OK"),
      ),
  );
  await send("shell deny");
  await speech.locator("#approval").waitFor({ state: "visible" });
  await speech.locator("#deny").click();
  await idle();
  assert.match(await speech.locator("#speech").textContent(), /没有执行/);
  await send("mcp");
  await speech.locator("#approval").waitFor({ state: "visible" });
  await speech.locator("#allow").click();
  await idle();
  assert.ok(
    requests
      .at(-1)
      .messages.some(
        (m) => m.role === "tool" && m.content.includes("echo:hello:auth=true"),
      ),
  );
  console.log("PASS: 宠物气泡显示具体确认，Shell 同意/拒绝和 MCP 工具往返");
  const diaries = (await request("memory.list")).filter((p) =>
    p.startsWith("daily/"),
  );
  assert.equal(diaries.length, 1);
  assert.match(
    (await request("memory.read", { path: diaries[0] })).text,
    /remember/,
  );
  await request("chat.clear");
  assert.equal(
    (await request("memory.list")).filter((p) => p.startsWith("daily/")).length,
    1,
  );
  const status = await request("companion.status");
  assert.ok(status.home.startsWith(output));
  let exa;
  if (process.argv.includes("--exa-live")) {
    try {
      const c = (await request("mcp.list")).find((c) => c.id === "exa");
      await request("mcp.save", { ...c, enabled: true });
      exa = await request("mcp.connect", { id: "exa" });
      console.log("PASS: Exa 官方连接，工具 " + exa.tools.join(", "));
    } catch (e) {
      exa = { error: e.message };
      console.log("Exa 实测受限：" + e.message);
    }
  }
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        passed: true,
        exa,
        checks: [
          "model-list-inflight-edit",
          "core-refinement",
          "skill-install-toggle-preview",
          "mcp-stdio-credentials-tools",
          "pet-shell-approval-allow-deny",
          "mcp-tool-roundtrip",
          "daily-persistence",
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log("AGENT SMOKE OUTPUT: " + output);
} catch (e) {
  console.error(errors.join("\n"));
  throw e;
} finally {
  await controller?.close().catch(() => {});
  await runtime?.close().catch(() => {});
  mock.closeAllConnections();
  await new Promise((r) => mock.close(r));
}
