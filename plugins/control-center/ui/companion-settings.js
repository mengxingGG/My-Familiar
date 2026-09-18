export function createCompanionSettings(api, toast) {
  const $ = (id) => document.getElementById(id);
  const nav = document.querySelector("nav");
  for (const [id, label] of [
    ["memories", "记忆与日记"],
    ["skills", "Skills"],
    ["mcp", "MCP 工具"],
  ]) {
    const b = document.createElement("button");
    b.dataset.page = id;
    const icon = document.createElement("span");
    icon.textContent = { memories: "◷", skills: "◇", mcp: "⌘" }[id];
    b.append(icon, document.createTextNode(label));
    nav.insertBefore(b, nav.lastElementChild);
  }
  const host = document.createElement("div");
  host.innerHTML = `
    <div id="agent-confirmations" class="card form" hidden><h3>宠物正在等待你的确认</h3><b id="confirm-title"></b><pre id="confirm-detail"></pre><div class="row"><select id="confirm-scope" aria-label="允许范围"><option value="once">仅本次</option><option value="session">本会话同工具一直允许</option><option value="whitelist">此操作加入白名单</option></select><button id="confirm-allow" class="primary">允许</button><button id="confirm-deny" class="ghost">拒绝</button></div></div>
    <section id="memories" class="page" hidden>
      <div class="card form"><b>一起积累的记忆</b><small id="home-path"></small><small id="memory-health"></small><div class="row"><input id="memory-search" placeholder="搜索关键词或日期，如 2026-09-18"><button id="memory-search-button" class="ghost">检索</button><button id="memory-reload" class="ghost">全部文件</button></div><div id="memory-results"></div></div>
      <div class="memory-layout"><div class="card form"><label>记忆文件<select id="memory-files" size="14"></select></label></div><div class="card form"><b id="memory-file-title">选择记忆文件</b><textarea id="memory-editor" rows="17" spellcheck="false" aria-label="记忆内容"></textarea><small id="core-count"></small><div class="row"><small>修改保留备份。核心超限会调用模型精炼。</small><button id="memory-save" class="primary">保存记忆</button></div></div></div>
    </section>
    <section id="skills" class="page" hidden><div class="card form"><b>把会做的事，整理成方法</b><p>Skill 是可按需读取的说明文件。停用后宠物不再加载它；安装不会自动执行其中的脚本。</p><div id="skills-list"></div></div>
      <div class="card form"><h3>安装 Skill</h3><label>本地目录、SKILL.md 路径或 HTTPS 文件地址<input id="skill-source" placeholder="C:\\路径\\my-skill 或 https://…/SKILL.md"></label><label>也可以直接粘贴完整 SKILL.md<textarea id="skill-content" rows="8" placeholder="---&#10;name: my-skill&#10;description: 什么时候使用它&#10;---&#10;具体步骤"></textarea></label><button id="skill-install" class="primary">安装到宠物目录</button><pre id="skill-preview" hidden></pre></div>
    </section>
    <section id="mcp" class="page" hidden><div class="card form"><b>按需连接外部工具</b><p>Exa 和高德已预置，启用后可以搜索和读取网页。密钥加密保存；其他工具按具体操作确认。</p><div id="mcp-list"></div></div>
      <div class="card form"><h3 id="mcp-edit-title">添加 / 编辑 MCP</h3><div class="parameter-grid"><label>ID<input id="mcp-id" placeholder="my-mcp"></label><label>名称<input id="mcp-name" placeholder="工具名称"></label><label>连接方式<select id="mcp-transport"><option value="http">Streamable HTTP</option><option value="stdio">本地 stdio</option></select></label><label class="inline-check"><input id="mcp-enabled" type="checkbox">启用（本地服务会运行程序）</label></div>
      <label id="mcp-url-row">服务 URL<input id="mcp-url" placeholder="https://mcp.exa.ai/mcp"></label><div id="mcp-local-row" hidden><label>程序<input id="mcp-command" placeholder="node 或程序完整路径"></label><label>参数（每行一项）<textarea id="mcp-args" rows="3"></textarea></label><small>stdio 服务是本机程序，请仅启用可信来源。工作目录在宠物之家。</small></div>
      <div class="parameter-grid"><label>鉴权位置<select id="mcp-auth-kind"><option value="header">HTTP Header</option><option value="query">URL 查询参数（密钥仍加密保存）</option><option value="env">stdio 环境变量</option></select></label><label>鉴权字段名（无需鉴权可留空）<input id="mcp-auth-name" placeholder="x-api-key 或 API_KEY"></label><label>Header 前缀（可选）<input id="mcp-auth-prefix" placeholder="Bearer "></label></div><label>API Key<input id="mcp-key" type="password" autocomplete="off" placeholder="留空保留原密钥"></label><small id="mcp-key-state"></small>
      <div class="row"><button id="mcp-new" class="ghost">新配置</button><button id="mcp-delete-key" class="ghost danger">删除此配置的密钥</button><button id="mcp-save" class="primary">保存配置和密钥</button></div></div>
      <div class="card form"><h3>安装本地 MCP 包</h3><label>服务 ID<input id="mcp-package-id" placeholder="my-server"></label><label>固定版本 npm 包<input id="mcp-package" placeholder="@scope/server@1.2.3"></label><small>安装到宠物目录，跳过 npm 安装脚本，安装后默认停用。需要已安装 Node.js。</small><button id="mcp-install" class="primary">安装 MCP</button></div>
    </section>`;
  document.querySelector("main").insertBefore(host, $("toast"));
  let memoryPath = "",
    memoryRevision,
    memoryDirty = false,
    memoryTruncated = false,
    approvalId,
    servers = [];
  async function run(id, fn) {
    const b = $(id);
    b.disabled = true;
    try {
      return await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      b.disabled = false;
    }
  }
  function button(text, fn, cls = "ghost") {
    const b = document.createElement("button");
    b.textContent = text;
    b.className = cls;
    b.onclick = () => {
      b.disabled = true;
      Promise.resolve()
        .then(fn)
        .catch((e) => toast(e.message, true))
        .finally(() => {
          b.disabled = false;
        });
    };
    return b;
  }
  function row(title, detail, actions) {
    const r = document.createElement("div");
    r.className = "extension-row";
    const text = document.createElement("div"),
      b = document.createElement("b"),
      small = document.createElement("small");
    b.textContent = title;
    small.textContent = detail;
    text.append(b, small);
    const buttons = document.createElement("div");
    buttons.className = "extension-actions";
    buttons.append(...actions);
    r.append(text, buttons);
    return r;
  }
  async function openMemory(path) {
    if (memoryDirty && !confirm("放弃这份记忆尚未保存的修改？")) return;
    const data = await api.request("memory.read", { path });
    memoryPath = path;
    memoryRevision = data.revision;
    memoryTruncated = !!data.truncated;
    $("memory-editor").readOnly = memoryTruncated;
    memoryDirty = false;
    $("memory-editor").value = data.text;
    $("memory-file-title").textContent = path;
    $("memory-files").value = path;
    count();
  }
  function count() {
    $("core-count").textContent = memoryTruncated
      ? "文件较长：当前只预览前 10 万字符，请在宠物记忆目录中编辑完整文件。"
      : memoryPath === "CORE.md"
        ? `${Array.from($("memory-editor").value).length} / 3000 字符（超出后自动精炼）`
        : "日记按当地日期追加；可在这里整理更正。";
  }
  async function memories() {
    const files = await api.request("memory.list");
    $("memory-files").replaceChildren(
      ...files.map((p) => {
        const o = document.createElement("option");
        o.value = o.textContent = p;
        return o;
      }),
    );
    if (memoryPath && files.includes(memoryPath))
      $("memory-files").value = memoryPath;
    else await openMemory("CORE.md");
  }
  $("memory-editor").oninput = () => {
    memoryDirty = true;
    count();
  };
  $("memory-files").onchange = () =>
    run("memory-save", () => openMemory($("memory-files").value));
  $("memory-reload").onclick = () =>
    run("memory-reload", async () => {
      $("memory-results").replaceChildren();
      await memories();
    });
  $("memory-save").onclick = () =>
    run("memory-save", async () => {
      if (!memoryPath) return;
      if (memoryTruncated)
        throw new Error(
          "文件较长，当前仅预览前 10 万字符，请在宠物记忆目录中编辑完整文件",
        );
      await api.request("memory.write", {
        path: memoryPath,
        text: $("memory-editor").value,
        revision: memoryRevision,
      });
      memoryDirty = false;
      await openMemory(memoryPath);
      toast("记忆已保存，下一轮对话生效");
    });
  $("memory-search-button").onclick = () =>
    run("memory-search-button", async () => {
      const results = await api.request("memory.search", {
        query: $("memory-search").value,
      });
      $("memory-results").replaceChildren(
        ...results.map((r) =>
          row(r.path, r.excerpt, [button("打开", () => openMemory(r.path))]),
        ),
      );
      if (!results.length) $("memory-results").textContent = "没有匹配的记忆。";
    });
  async function skills() {
    const items = await api.request("skills.list");
    $("skills-list").replaceChildren(
      ...items.map((s) =>
        row(
          s.id,
          (s.enabled ? "已启用 · " : "已停用 · ") + (s.error || s.description),
          [
            button(s.enabled ? "停用" : "启用", async () => {
              await api.request("skills.toggle", {
                id: s.id,
                enabled: !s.enabled,
              });
              await skills();
            }),
            button("查看", async () => {
              $("skill-preview").textContent = await api.request(
                "skills.read",
                { id: s.id },
              );
              $("skill-preview").hidden = false;
            }),
            button(
              "移除",
              async () => {
                if (confirm(`移除 ${s.id}？文件会保留在 .removed 备份。`)) {
                  await api.request("skills.remove", { id: s.id });
                  await skills();
                }
              },
              "ghost danger",
            ),
          ],
        ),
      ),
    );
  }
  $("skill-install").onclick = () =>
    run("skill-install", async () => {
      await api.request("skills.install", {
        source: $("skill-source").value.trim(),
        content: $("skill-content").value || undefined,
      });
      $("skill-content").value = "";
      await skills();
      toast("Skill 已安装到宠物目录");
    });
  function transport() {
    $("mcp-url-row").hidden = $("mcp-transport").value !== "http";
    $("mcp-local-row").hidden = !$("mcp-url-row").hidden;
  }
  function editMcp(
    c = { id: "", name: "", transport: "http", enabled: false },
  ) {
    $("mcp-id").value = c.id;
    $("mcp-id").readOnly = !!c.id;
    $("mcp-name").value = c.name;
    $("mcp-transport").value = c.transport;
    $("mcp-url").value = c.url || "";
    $("mcp-command").value = c.command || "";
    $("mcp-args").value = (c.args || []).join("\n");
    $("mcp-enabled").checked = c.enabled;
    $("mcp-auth-name").value = c.auth?.name || "";
    $("mcp-auth-kind").value =
      c.auth?.kind || (c.transport === "stdio" ? "env" : "header");
    $("mcp-auth-prefix").value = c.auth?.prefix || "";
    $("mcp-key").value = "";
    $("mcp-key-state").textContent = c.hasKey
      ? "此配置已保存加密密钥。"
      : "此配置尚无密钥。";
    transport();
  }
  $("mcp-transport").onchange = transport;
  $("mcp-new").onclick = () => editMcp();
  async function mcps() {
    servers = await api.request("mcp.list");
    $("mcp-list").replaceChildren(
      ...servers.map((c) =>
        row(
          c.name,
          `${c.id} · ${c.connected ? `已连接 ${c.tools} 个工具` : c.enabled ? "已启用，尚未连接" : "未启用"}${c.error ? " · " + c.error : ""}`,
          [
            button("配置", () => editMcp(c)),
            button(c.connected ? "重连" : "连接", async () => {
              if (!c.enabled) {
                toast("请先在配置中启用服务", true);
                editMcp(c);
                return;
              }
              const result = await api.request("mcp.connect", { id: c.id });
              await mcps();
              toast(`已连接：${result.tools.join("、")}`);
            }),
            button(
              "移除",
              async () => {
                if (confirm(`移除 ${c.name} 的连接配置？本地包保留。`)) {
                  await api.request("mcp.remove", { id: c.id });
                  await mcps();
                  if ($("mcp-id").value === c.id) editMcp();
                }
              },
              "ghost danger",
            ),
          ],
        ),
      ),
    );
  }
  $("mcp-save").onclick = () =>
    run("mcp-save", async () => {
      const kind = $("mcp-transport").value;
      const c = {
        id: $("mcp-id").value.trim(),
        name: $("mcp-name").value.trim(),
        transport: kind,
        enabled: $("mcp-enabled").checked,
        ...(kind === "http"
          ? { url: $("mcp-url").value.trim() }
          : {
              command: $("mcp-command").value.trim(),
              args: $("mcp-args").value.split("\n").filter(Boolean),
            }),
      };
      if ($("mcp-auth-name").value.trim())
        c.auth = {
          kind: kind === "stdio" ? "env" : $("mcp-auth-kind").value,
          name: $("mcp-auth-name").value.trim(),
          prefix: $("mcp-auth-prefix").value,
        };
      await api.request("mcp.save", c);
      if ($("mcp-key").value) {
        await api.request("mcp.key", { id: c.id, key: $("mcp-key").value });
        $("mcp-key").value = "";
      }
      await mcps();
      editMcp(servers.find((s) => s.id === c.id));
      toast("配置已保存");
      if (c.enabled) {
        await api.request("mcp.connect", { id: c.id });
        await mcps();
        toast("MCP 已连接，下一轮对话可用");
      }
    });
  $("mcp-delete-key").onclick = () =>
    run("mcp-delete-key", async () => {
      if (confirm("删除此配置的 API Key？")) {
        await api.request("mcp.key", { id: $("mcp-id").value, key: "" });
        $("mcp-key").value = "";
        $("mcp-key-state").textContent = "密钥已删除";
        await mcps();
      }
    });
  $("mcp-install").onclick = () =>
    run("mcp-install", async () => {
      await api.request("mcp.install", {
        id: $("mcp-package-id").value.trim(),
        package: $("mcp-package").value.trim(),
      });
      await mcps();
      toast("已安装，默认停用；请配置后启用");
    });
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const s = await api.request("companion.status");
      $("home-path").textContent = `宠物之家：${s.home}`;
      $("memory-health").textContent = s.memory.refining
        ? "正在精炼核心记忆…"
        : s.memory.lastError || "核心记忆、日记与教训分开保存。";
      const a = s.approvals[0];
      if (approvalId !== a?.id) $("confirm-scope").value = "once";
      $("confirm-scope").disabled = !a?.rule;
      approvalId = a?.id;
      $("agent-confirmations").hidden = !a;
      $("confirm-title").textContent = a?.title || "";
      $("confirm-detail").textContent = a?.detail || "";
    } catch {
      $("agent-confirmations").hidden = true;
    } finally {
      polling = false;
    }
  }
  for (const [id, allow] of [
    ["confirm-allow", true],
    ["confirm-deny", false],
  ])
    $(id).onclick = () =>
      run(id, async () => {
        await api.request("agent.decide", {
          id: approvalId,
          allow,
          choice: $("confirm-scope").value,
        });
        await poll();
      });
  setInterval(() => {
    if (!document.hidden) void poll();
  }, 1500);
  return {
    activate(page) {
      void poll();
      if (page === "memories")
        void memories().catch((e) => toast(e.message, true));
      if (page === "skills") void skills().catch((e) => toast(e.message, true));
      if (page === "mcp") void mcps().catch((e) => toast(e.message, true));
    },
  };
}
