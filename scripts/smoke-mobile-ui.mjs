import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import assert from "node:assert/strict";

const output = resolve(".artifacts/android-frontend/screenshots");
await mkdir(output, { recursive: true });
async function serve(production = false) {
  const child = spawn(
    process.execPath,
    ["scripts/preview-mobile-ui.mjs", ...(production ? ["--production"] : [])],
    {
      cwd: process.cwd(),
      env: { ...process.env, FAMILIAR_MOBILE_PORT: "0" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Preview server timed out: " + log));
    }, 30_000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Server exited: " + code + " " + log));
    });
    child.stderr.on("data", (data) => {
      log += data;
    });
    child.stdout.on("data", (data) => {
      log += data;
      const match = log.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolveUrl(match[0]);
      }
    });
  });
  return { child, url };
}
const servers = [];
let browser;
const errors = [];
const results = [];
let page;
const check = async (name, run) => {
  await run();
  results.push(name);
  console.log("PASS " + name);
};
const visible = async (locator) =>
  locator.waitFor({ state: "visible", timeout: 5000 });
const back = async () => {
  await page.getByRole("button", { name: "返回", exact: true }).last().click();
  await page.waitForTimeout(80);
};
const shot = async (name) =>
  page.screenshot({ path: resolve(output, name + ".png") });
const responsive = async (name) => {
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 844 });
    await page.waitForTimeout(30);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      name + ": horizontal overflow",
    );
    const small = await page.locator("button:visible").evaluateAll((buttons) =>
      buttons
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return !b.closest("[inert]") && (r.width < 47 || r.height < 47);
        })
        .map((b) => b.textContent),
    );
    assert.deepEqual(small, [], name + ": small touch target");
    await shot(name + "-" + width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
};
try {
  const preview = await serve();
  servers.push(preview);
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  context.setDefaultTimeout(5000);
  await context.route("**/*", (route) => {
    const u = new URL(route.request().url());
    return u.hostname === "127.0.0.1" ? route.continue() : route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(preview.url);
  await visible(page.locator('#familiar-root[data-ready="true"]'));
  for (const width of [360, 390, 430, 768]) {
    await page.setViewportSize({ width, height: width === 768 ? 1024 : 844 });
    await check("home layout " + width, async () => {
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      const small = await page
        .locator("button:visible")
        .evaluateAll((buttons) =>
          buttons
            .filter((b) => {
              const r = b.getBoundingClientRect();
              return !b.closest("[inert]") && (r.width < 47 || r.height < 47);
            })
            .map((b) => ({
              text: b.textContent,
              width: b.getBoundingClientRect().width,
              height: b.getBoundingClientRect().height,
            })),
        );
      assert.deepEqual(small, []);
      await shot("home-" + width);
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await check("pet touch", async () => {
    await page.getByRole("button", { name: "摸摸小森" }).click();
    await visible(page.locator(".pet-bubble"));
  });
  await check("provider save and secret never refilled", async () => {
    await page.getByRole("button", { name: "去连接", exact: true }).click();
    await page.locator('.page:not([hidden])').getByLabel(/服务地址/).fill("https://example.com/v1");
    await page.getByLabel("模型", { exact: true }).fill("preview-model");
    await page
      .getByLabel("API 密钥", { exact: true })
      .fill("TEST-ONLY-NOT-A-REAL-KEY");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await visible(
      page.getByText("已保存。密钥已交给灵伴保管。", { exact: true }),
    );
    assert.equal(
      await page.getByLabel("API 密钥", { exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    await responsive("model");
    await back();
  });
  await check(
    "seven provider profiles and key drafts stay isolated",
    async () => {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: /模型连接/ }).click();
      assert.equal(await page.locator(".kind-option").count(), 7);
      await page
        .getByLabel("API 密钥", { exact: true })
        .fill("DISCARD-ON-SWITCH");
      await page.locator('.kind-option[data-kind="gemini"]').click();
      assert.equal(
        await page.getByLabel("API 密钥", { exact: true }).inputValue(),
        "",
      );
      assert.equal(
        await page.locator('.page:not([hidden])').getByLabel(/服务地址/).inputValue(),
        "https://generativelanguage.googleapis.com/v1beta",
      );
      assert.equal(
        await page.getByLabel("模型", { exact: true }).inputValue(),
        "",
      );
      await page.getByLabel("模型", { exact: true }).fill("preview-gemini");
      await page
        .getByLabel("API 密钥", { exact: true })
        .fill("PREVIEW-GEMINI-KEY");
      await page
        .getByRole("button", { name: "保存并改用", exact: true })
        .click();
      await visible(
        page.getByText(
          "已保存，之后改用Gemini 官方聊天。密钥已交给灵伴保管。",
          { exact: true },
        ),
      );
      await page.locator('.kind-option[data-kind="compatible"]').click();
      assert.equal(
        await page.locator('.page:not([hidden])').getByLabel(/服务地址/).inputValue(),
        "https://example.com/v1",
      );
      assert.equal(
        await page.getByLabel("模型", { exact: true }).inputValue(),
        "preview-model",
      );
      await page.locator('.page:not([hidden])').getByLabel(/服务地址/).fill("https://another.example/v1");
      await visible(page.getByText(/换了服务地址，新地址还没有保存过密钥/));
      await page.locator('.page:not([hidden])').getByLabel(/服务地址/).fill("https://example.com/v1");
      await page
        .getByRole("button", { name: "保存并改用", exact: true })
        .click();
      await visible(
        page.getByText("已保存，之后改用OpenAI 兼容聊天。", { exact: true }),
      );
      await back();
      await page.getByRole("button", { name: "小窝", exact: true }).click();
    },
  );
  await check("character and companion save", async () => {
    await page.getByRole("button", { name: "换个样子" }).click();
    assert.equal(await page.locator(".char-option").count(), 7);
    await page.locator('.char-option[data-character="mianmian"]').click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".char-option img")].every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    );
    await page.locator('.char-option[data-character="youzi"]').click();
    await page.getByLabel("怎么称呼它", { exact: true }).fill("柚子");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await visible(
      page.getByText("已保存，从下一句话开始生效。", { exact: true }),
    );
    await responsive("companion");
    await back();
    await visible(page.getByRole("button", { name: "摸摸柚子" }));
  });
  await page.getByRole("button", { name: "说句话" }).click();
  const composer = page.getByLabel("想说的话", { exact: true });
  await check("Chinese IME and Enter do not send", async () => {
    await composer.fill("你好");
    const before = await page.locator(".msg-list").textContent();
    await composer.press("Enter");
    await composer.dispatchEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
      keyCode: 229,
    });
    assert.equal(await page.locator(".msg-list").textContent(), before);
    assert.match(await composer.inputValue(), /\n/);
  });
  await check("stream keeps next draft; stop blocks late text", async () => {
    await composer.fill("今天想聊聊");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await visible(page.getByRole("button", { name: "停止回复", exact: true }));
    await composer.fill("下一句话还没写完");
    await page.waitForTimeout(150);
    assert.equal(await composer.inputValue(), "下一句话还没写完");
    await page.getByRole("button", { name: "停止回复", exact: true }).click();
    await visible(page.getByRole("button", { name: "发送", exact: true }));
    const stopped = await page.locator(".msg-list").textContent();
    await page.waitForTimeout(180);
    assert.equal(await page.locator(".msg-list").textContent(), stopped);
    assert.match(
      await page.locator('#familiar-root > [aria-live="polite"]').textContent(),
      /已停止/,
    );
    await responsive("chat");
  });
  await check("short viewport keeps composer reachable", async () => {
    await page.setViewportSize({ width: 390, height: 480 });
    await page.waitForTimeout(50);
    const box = await composer.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 480);
    assert.equal(await composer.inputValue(), "下一句话还没写完");
    await shot("chat-short-viewport");
    await page.setViewportSize({ width: 390, height: 844 });
  });
  await check("calendar task approval and handoff state", async () => {
    await composer.fill("帮我放进日历");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await visible(
      page.locator(".chat-tasks").getByText("等你确认", { exact: true }),
    );
    await page
      .locator(".chat-tasks")
      .getByRole("button", { name: /批准/ })
      .click();
    await visible(
      page.locator(".chat-tasks").getByText("等你操作", { exact: true }),
    );
    assert.equal(
      await page
        .locator(".chat-tasks")
        .getByText("已完成", { exact: true })
        .count(),
      0,
    );
    await responsive("task");
  });
  await check("history opens, selects and confirms deletion", async () => {
    await page.getByRole("button", { name: "聊天记录", exact: true }).click();
    await visible(page.getByRole("dialog", { name: "聊天记录" }));
    await page
      .locator('.history-row[data-id="yesterday"] .history-open')
      .click();
    await visible(
      page.getByRole("heading", { name: "留住一个小灵感", exact: true }),
    );
    await page.getByRole("button", { name: "聊天记录", exact: true }).click();
    await page
      .getByRole("button", { name: "删除「留住一个小灵感」", exact: true })
      .click();
    await visible(page.getByRole("alertdialog"));
    await responsive("delete");
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await page.waitForTimeout(150);
    assert.equal(
      await page.locator('.history-row[data-id="yesterday"]').count(),
      0,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(80);
    await back();
  });
  await check(
    "capabilities reflect core facts and unavailable remains unavailable",
    async () => {
      await page
        .getByRole("button", { name: "能力", exact: false })
        .filter({ has: page.locator(".dock-label") })
        .click();
      await page.getByRole("button", { name: "日历：授权说明与详情" }).click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "去授权", exact: true })
        .click();
      await visible(
        page.getByRole("dialog").getByText("已授权", { exact: true }),
      );
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      await page
        .getByRole("button", { name: "跨应用协助：授权说明与详情" })
        .click();
      await visible(
        page.getByRole("dialog").getByText("暂不可用", { exact: true }),
      );
      assert.equal(
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "去授权", exact: true })
          .count(),
        0,
      );
      await responsive("capability");
    },
  );
  await check(
    "resident controls use snapshots and accessibility asks before system handoff",
    async () => {
      await page.goto(preview.url + "?native=1");
      await visible(page.locator(".resident"));
      await responsive("resident");
      await page.getByRole("button", { name: "开启常驻", exact: true }).click();
      await visible(
        page.getByRole("button", { name: "停止常驻", exact: true }),
      );
      await page.getByRole("button", { name: "停止常驻", exact: true }).click();
      await visible(
        page.getByRole("button", { name: "开启常驻", exact: true }),
      );
      await page
        .getByRole("button", { name: "能力", exact: false })
        .filter({ has: page.locator(".dock-label") })
        .click();
      await page
        .getByRole("button", { name: "跨应用协助：授权说明与详情" })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "去系统设置", exact: true })
        .click();
      await visible(page.getByRole("alertdialog"));
      await page.keyboard.press("Escape");
      await visible(
        page.getByRole("dialog").getByText("未授权", { exact: true }),
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "去系统设置", exact: true })
        .click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "去系统设置", exact: true })
        .click();
      await visible(
        page.getByRole("dialog").getByText("已授权", { exact: true }),
      );
      await responsive("accessibility-disclosure");
    },
  );
  const production = await serve(true);
  servers.push(production);
  await check(
    "production without native host fails visibly, no demo fallback",
    async () => {
      await page.goto(production.url);
      await visible(page.getByText("没有连上灵伴", { exact: true }));
      assert.equal(
        await page.locator("#familiar-root").getAttribute("data-ready"),
        "false",
      );
      assert.equal(
        await page.getByText("预览 · 示例数据", { exact: true }).isVisible(),
        false,
      );
      await shot("unconnected-390");
    },
  );
  // 通过真实传输桥注入延迟宿主，验证跨会话与保存结果不确定的真实 UI 路径。
  await page.addInitScript(() => {
    const state = {
      protocolVersion: 1,
      revision: 0,
      mode: "live",
      characters: [
        {
          id: "mori",
          name: "小森",
          description: "测试伙伴",
          image: "./characters/mori/idle-0.svg",
        },
      ],
      companion: { characterId: "mori", nickname: "小森", persona: "测试" },
      provider: {
        baseUrl: "https://example.com/v1",
        model: "test-model",
        keyConfigured: false,
      },
      conversations: [
        {
          id: "a",
          title: "测试会话 A",
          updatedAt: "2026-10-19T00:00:00Z",
          messages: [],
        },
        {
          id: "b",
          title: "测试会话 B",
          updatedAt: "2026-10-18T00:00:00Z",
          messages: [],
        },
      ],
      activeConversationId: "a",
      activeReply: null,
      capabilities: [],
      tasks: [],
    };
    let listener;
    const control = (window.mobileTest = {
      state,
      send: null,
      save: null,
      emit() {
        state.revision++;
        listener?.(structuredClone(state));
      },
    });
    window.familiarMobileTransport = {
      listen(fn) {
        listener = fn;
        return () => {
          listener = null;
        };
      },
      async invoke(request) {
        const ok = (result) => ({
          protocolVersion: 1,
          id: request.id,
          ok: true,
          result,
        });
        if (request.method === "snapshot.get")
          return ok(structuredClone(state));
        if (request.method === "conversation.select") {
          state.activeConversationId = request.params.id;
          control.emit();
          return ok();
        }
        if (request.method === "message.send")
          return new Promise((resolve) => {
            control.send = {
              params: request.params,
              fail() {
                resolve({
                  protocolVersion: 1,
                  id: request.id,
                  ok: false,
                  error: { code: "PROVIDER" },
                });
              },
            };
          });
        if (request.method === "provider.save")
          return new Promise((resolve) => {
            control.save = {
              fail() {
                resolve({
                  protocolVersion: 1,
                  id: request.id,
                  ok: false,
                  error: { code: "UNAVAILABLE" },
                });
              },
            };
          });
        return ok();
      },
    };
  });
  await page.reload();
  await visible(page.locator('#familiar-root[data-ready="true"]'));
  await page.getByRole("button", { name: "说句话" }).click();
  const switchConversation = async (id) => {
    await page.getByRole("button", { name: "聊天记录", exact: true }).click();
    await page.locator(`.history-row[data-id="${id}"] .history-open`).click();
    await page
      .getByRole("dialog", { name: "聊天记录" })
      .waitFor({ state: "hidden" });
  };
  await check("drafts are isolated per conversation", async () => {
    await composer.fill("会话 A 的草稿");
    await switchConversation("b");
    assert.equal(await composer.inputValue(), "");
    await composer.fill("会话 B 的草稿");
    await switchConversation("a");
    assert.equal(await composer.inputValue(), "会话 A 的草稿");
  });
  await check(
    "late send failure restores only the originating draft",
    async () => {
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page.waitForFunction(() => !!window.mobileTest.send);
      assert.equal(
        await page.evaluate(() => window.mobileTest.send.params.conversationId),
        "a",
      );
      await switchConversation("b");
      assert.equal(await composer.inputValue(), "会话 B 的草稿");
      await composer.fill("");
      await page.evaluate(() => window.mobileTest.send.fail());
      await page.waitForTimeout(80);
      assert.equal(await composer.inputValue(), "");
      await switchConversation("a");
      assert.equal(await composer.inputValue(), "会话 A 的草稿");
    },
  );
  await check(
    "save acknowledgement failure does not claim the key was not saved",
    async () => {
      await back();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: /模型连接/ }).click();
      await page.getByLabel("API 密钥", { exact: true }).fill("TEST-NONSECRET");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await page.waitForFunction(() => !!window.mobileTest.save);
      await page.evaluate(() => window.mobileTest.save.fail());
      await page.waitForTimeout(80);
      assert.equal(
        await page.getByLabel("API 密钥", { exact: true }).inputValue(),
        "",
      );
      const status = await page
        .locator(".page:not([hidden]) .form-status[data-tone=bad]")
        .textContent();
      assert.doesNotMatch(status, /密钥没有保存/);
      assert.match(status, /确认|检查|核对/);
    },
  );
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, "../smoke-result.json"),
    JSON.stringify({ passed: results, errors }, null, 2),
  );
} catch (error) {
  if (page) await shot("failure").catch(() => {});
  await writeFile(
    resolve(output, "../smoke-result.json"),
    JSON.stringify(
      { passed: results, errors, failure: String(error) },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser?.close();
  for (const server of servers) server.child.kill();
}
