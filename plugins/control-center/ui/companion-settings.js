export function createCompanionSettings(api, toast) {
  const $ = (id) => document.getElementById(id);
  $("memories").innerHTML = `
    <div class="group">
      <p id="memory-health" class="group-note"></p><p class="group-note"><small id="home-path"></small></p>
      <div class="toolbar"><input id="memory-search" type="search" placeholder="搜索关键词或日期，例如 2026-09-18" aria-label="搜索记忆"><button id="memory-search-button" class="quiet">搜索</button><button id="memory-reload" class="quiet">显示全部文件</button></div>
      <div id="memory-results" class="panel list" hidden></div>
    </div>
    <div class="split">
      <div class="panel side-list"><select id="memory-files" size="18" aria-label="记忆文件"></select></div>
      <div class="panel detail">
        <div class="detail-head"><b id="memory-file-title">选择一个记忆文件</b></div>
        <textarea id="memory-editor" rows="18" spellcheck="false" aria-label="记忆内容"></textarea>
        <div class="editor-foot"><small id="core-count"></small><button id="memory-save" class="primary">保存记忆</button></div>
        <small>保存前的版本会留作备份。核心规则超出上限时不会保存，请先合并或删减。</small>
      </div>
    </div>`;
  $("skills").innerHTML = `
    <div class="group"><h3>已安装</h3><div id="skills-list" class="panel list"></div><pre id="skill-preview" class="code-block" hidden></pre></div>
    <div class="group"><h3>安装 Skill</h3><div class="panel panel-form">
      <label class="field">本地目录、SKILL.md 路径或 HTTPS 文件地址<input id="skill-source" placeholder="C:\\路径\\my-skill 或 https://…/SKILL.md" spellcheck="false"></label>
      <label class="field">或者直接粘贴完整的 SKILL.md<textarea id="skill-content" rows="8" placeholder="---&#10;name: my-skill&#10;description: 什么时候使用它&#10;---&#10;具体步骤"></textarea></label>
      <div class="button-row"><button id="skill-install" class="primary">安装到宠物目录</button></div>
    </div></div>`;
  $("mcp").innerHTML = `
    <div class="group"><h3>已配置的服务</h3><p class="group-note">已预置 Exa 和高德，填好密钥并启用后即可搜索网页、查询地点。其它工具按具体操作确认。</p><div id="mcp-list" class="panel list"></div></div>
    <div class="group"><h3 id="mcp-edit-title">添加或编辑服务</h3><div class="panel panel-form">
      <div class="field-grid"><label class="field">ID<input id="mcp-id" placeholder="my-mcp" spellcheck="false"></label><label class="field">名称<input id="mcp-name" placeholder="工具名称"></label>
      <label class="field">连接方式<select id="mcp-transport"><option value="http">Streamable HTTP</option><option value="stdio">本地 stdio 程序</option></select></label>
      <span class="field"><span>启用</span><label class="check"><input id="mcp-enabled" type="checkbox">保存后连接（本地服务会运行程序）</label></span></div>
      <label id="mcp-url-row" class="field">服务 URL<input id="mcp-url" placeholder="https://mcp.exa.ai/mcp" spellcheck="false"></label>
      <div id="mcp-local-row" class="field-grid" hidden><label class="field">程序<input id="mcp-command" placeholder="node 或程序完整路径" spellcheck="false"></label><label class="field">参数（每行一项）<textarea id="mcp-args" rows="3" spellcheck="false"></textarea><small>只启用来源可信的程序。工作目录在宠物之家。</small></label></div>
      <div class="field-grid"><label class="field">鉴权位置<select id="mcp-auth-kind"><option value="header">HTTP Header</option><option value="query">URL 查询参数（密钥仍加密保存）</option><option value="env">stdio 环境变量</option></select></label>
      <label class="field">鉴权字段名<input id="mcp-auth-name" placeholder="x-api-key 或 API_KEY" spellcheck="false"><small>不需要鉴权时留空。</small></label>
      <label class="field">Header 前缀（可选）<input id="mcp-auth-prefix" placeholder="Bearer "></label>
      <label class="field">API Key<input id="mcp-key" type="password" autocomplete="off" placeholder="留空则保留原密钥"><small id="mcp-key-state"></small></label></div>
      <div class="button-row"><button id="mcp-new" class="quiet">新建配置</button><button id="mcp-delete-key" class="quiet danger">删除此配置的密钥</button><button id="mcp-save" class="primary">保存配置和密钥</button></div>
    </div></div>
    <div class="group"><h3>安装本地 MCP 包</h3><div class="panel panel-form">
      <div class="field-grid"><label class="field">服务 ID<input id="mcp-package-id" placeholder="my-server" spellcheck="false"></label><label class="field">固定版本的 npm 包<input id="mcp-package" placeholder="@scope/server@1.2.3" spellcheck="false"></label></div>
      <small>安装到宠物目录并跳过 npm 安装脚本，装好后默认停用。需要本机已安装 Node.js。</small>
      <div class="button-row"><button id="mcp-install" class="primary">安装 MCP 包</button></div>
    </div></div>`;
  let memoryPath = "",
    memoryRevision,
    memoryDirty = false,
    memoryTruncated = false,
    coreLimit = 2000,
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
  function button(text, fn, cls = "quiet") {
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
    const r = document.createElement("div"),
      text = document.createElement("div"),
      b = document.createElement("b"),
      small = document.createElement("small"),
      buttons = document.createElement("div");
    r.className = "list-row";
    text.className = "list-text";
    buttons.className = "list-actions";
    b.textContent = title;
    small.textContent = detail;
    text.append(b, small);
    buttons.append(...actions);
    r.append(text, buttons);
    return r;
  }
  function empty(target, text) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = text;
    target.replaceChildren(p);
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
      ? "文件较长，这里只预览前 10 万字符。请在宠物的记忆目录中编辑完整文件。"
      : memoryPath === "CORE.md"
        ? `${Array.from($("memory-editor").value).length} / ${coreLimit} 字符。只放必须遵守的规则和长期偏好，超出时不保存。`
        : /^(lessons|topics)\//.test(memoryPath)
          ? "第二行“> 何时读：”会进入记忆索引；每一条以“- ”开头。"
          : memoryPath.startsWith("daily/")
            ? "日记按当天日期追加，可以在这里整理或更正。"
            : "身份和相处约定会随会话一起交给模型。";
  }
  const layers = [
    ["核心与身份", (p) => !p.includes("/")],
    ["教训", (p) => p.startsWith("lessons/")],
    ["扩展记忆", (p) => p.startsWith("topics/")],
    ["日记", (p) => p.startsWith("daily/")],
  ];
  async function memories() {
    const files = await api.request("memory.list");
    const groups = layers
      .map(([label, test]) => {
        const items = files.filter(test);
        if (label === "日记") items.reverse();
        if (!items.length) return;
        const group = document.createElement("optgroup");
        group.label = label;
        group.append(...items.map((p) => new Option(p.split("/").pop(), p)));
        return group;
      })
      .filter(Boolean);
    $("memory-files").replaceChildren(...groups);
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
      $("memory-results").hidden = true;
      await memories();
    });
  $("memory-save").onclick = () =>
    run("memory-save", async () => {
      if (!memoryPath) return;
      if (memoryTruncated)
        throw new Error(
          "文件较长，这里只预览前 10 万字符，请在宠物的记忆目录中编辑完整文件",
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
  async function searchMemory() {
    const results = await api.request("memory.search", {
      query: $("memory-search").value,
    });
    $("memory-results").hidden = false;
    $("memory-results").replaceChildren(
      ...results.map((r) =>
        row(r.path, r.excerpt.trim(), [button("打开", () => openMemory(r.path))]),
      ),
    );
    if (!results.length) empty($("memory-results"), "没有匹配的记忆。");
  }
  $("memory-search-button").onclick = () =>
    run("memory-search-button", searchMemory);
  $("memory-search").onkeydown = (e) => {
    if (e.key === "Enter") void run("memory-search-button", searchMemory);
  };
  async function skills() {
    const items = await api.request("skills.list");
    $("skills-list").replaceChildren(
      ...items.map((s) =>
        row(
          s.id,
          (s.enabled ? "已启用。" : "已停用。") + (s.error || s.description),
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
                if (confirm(`移除 ${s.id}？文件会移到 .removed 备份。`)) {
                  await api.request("skills.remove", { id: s.id });
                  await skills();
                }
              },
              "quiet danger",
            ),
          ],
        ),
      ),
    );
    if (!items.length)
      empty($("skills-list"), "还没有 Skill。可以在下方安装。");
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
    $("mcp-edit-title").textContent = c.id
      ? `编辑 ${c.name || c.id}`
      : "添加或编辑服务";
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
      : "此配置还没有密钥。";
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
          `${c.id}：${c.connected ? `已连接 ${c.tools} 个工具` : c.enabled ? "已启用，尚未连接" : "未启用"}${c.error ? "。" + c.error : ""}`,
          [
            button("编辑", () => {
              editMcp(c);
              $("mcp-edit-title").scrollIntoView({ block: "start" });
            }),
            button(c.connected ? "重新连接" : "连接", async () => {
              if (!c.enabled) {
                toast("请先在配置中启用这个服务", true);
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
                if (confirm(`移除 ${c.name} 的连接配置？本地安装的包会保留。`)) {
                  await api.request("mcp.remove", { id: c.id });
                  await mcps();
                  if ($("mcp-id").value === c.id) editMcp();
                }
              },
              "quiet danger",
            ),
          ],
        ),
      ),
    );
    if (!servers.length) empty($("mcp-list"), "还没有 MCP 服务。");
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
        toast("MCP 已连接，下一轮对话可以使用");
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
      toast("已安装，默认停用；配置好后再启用");
    });
  editMcp();
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const s = await api.request("companion.status");
      $("home-path").textContent = `存放位置：${s.home}`;
      coreLimit = s.memory.core.limit;
      $("memory-health").textContent =
        s.memory.lastError ||
        `核心规则 ${s.memory.core.characters} / ${s.memory.core.limit} 字符，索引 ${s.memory.index.characters} / ${s.memory.index.limit} 字符${s.memory.index.omitted ? `，${s.memory.index.omitted} 个文件未列入索引` : ""}。日记、教训和扩展记忆由宠物按需读取。`;
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
