export function createExperienceSettings(api, toast) {
  const $ = (id) => document.getElementById(id);
  for (const [id, label] of [
    ["history", "历史会话"],
    ["permissions", "工具权限"],
    ["care", "主动关怀"],
  ]) {
    const b = document.createElement("button");
    b.dataset.page = id;
    b.textContent = label;
    document
      .querySelector("nav")
      .insertBefore(b, document.querySelector('nav [data-page="system"]'));
  }
  const host = document.createElement("div");
  host.innerHTML = `
  <section id="history" class="page" hidden>
    <div class="row history-toolbar"><input id="history-search" type="search" placeholder="搜索名称或对话内容" aria-label="搜索会话"><button id="history-search-button" class="ghost">搜索</button><button id="history-new" class="primary">新会话</button></div>
    <div class="history-layout"><div class="card form"><label>历史会话<select id="history-list" size="16"></select></label></div>
    <div class="card form history-detail"><div class="row"><b id="history-title">选择一段对话</b><button id="history-rename" class="ghost">重命名</button><button id="history-delete" class="ghost danger">删除</button></div>
    <div id="history-rename-form" class="row" hidden><input id="history-new-title" maxlength="100" aria-label="会话新名称"><button id="history-rename-save" class="primary">保存名称</button></div>
    <div class="row"><button id="history-previous" class="ghost">更早的消息</button><span id="history-range"></span><button id="history-next" class="ghost">更晚的消息</button></div>
    <div id="history-messages" aria-live="polite"></div><small id="history-state"></small>
    <button id="history-continue" class="ghost">继续此会话</button>
    <textarea id="history-input" rows="3" placeholder="Enter 换行 · Shift+Enter 发送" aria-label="历史会话文字输入"></textarea>
    <div class="row"><small>在此页对话时，宠物不冒泡。</small><button id="history-stop" class="ghost">停止回复</button><button id="history-send" class="primary">发送</button></div>
    </div></div>
  </section>
  <section id="permissions" class="page" hidden><div class="card form">
    <h3>默认怎么处理工具操作</h3><label>运行模式<select id="policy-mode"><option value="custom">按下面的规则处理</option><option value="auto">全自动：所有工具操作直接允许</option></select></label>
    <p id="policy-auto-note" hidden>全自动会允许 Shell、写入、安装和外部工具，拥有当前 Windows 用户可用的访问权限。位置授权仍单独设置。</p>
    <div id="policy-defaults"></div><small>工作目录是默认落点，绝对路径也可使用。白名单精确匹配文件目标或命令和参数；本会话授权适用于同一工具、同一操作类别，切换会话或重启后失效。</small>
    <div class="row"><button id="policy-revoke-session" class="ghost">撤销本会话授权</button><button id="policy-save" class="primary">保存权限策略</button></div></div>
    <div class="card form"><h3>已记住的白名单</h3><div id="policy-rules"></div></div>
  </section>
  <section id="care" class="page" hidden><div class="card form"><h3>惦记你，也尊重你的节奏</h3>
    <label class="setting"><span>开启主动关怀</span><input id="care-enabled" type="checkbox" role="switch"></label>
    <small>它会在合适的时候自然问候，结合相处记忆和最近的对话关心你。你正忙着聊天时，它会等一等。</small><small id="care-saved"></small></div>
    <div class="card form"><h3>你想让它记得的提醒</h3><p>只在这里管理自己添加的提醒，勾选后每天按指定时间启用。</p><div id="care-custom-list"></div>
    <label>提醒名称<input id="care-custom-label" maxlength="60" placeholder="例如：起来走走"></label><label>每天的时间<input id="care-custom-time" type="time" value="15:30"></label><label>希望它怎么提醒<textarea id="care-custom-prompt" rows="3" maxlength="2000" placeholder="例如：提醒我伸展一下，顺便喝点水。"></textarea></label><label class="inline-check"><input id="care-custom-enabled" type="checkbox">添加后启用</label><button id="care-custom-add" class="primary">添加自定义提醒</button></div>
    <div class="card form"><h3>位置与附近的好去处</h3>
    <label class="setting"><span>授权读取设备位置</span><input id="care-location" type="checkbox" role="switch"></label><small>只使用 Windows 的 GPS、Wi-Fi 或基站位置。拒绝 IP、默认位置和来源不明的结果。撤销授权会清除内存中的位置。</small>
    <label class="setting"><span>用高德查询附近餐馆</span><input id="care-nearby" type="checkbox" role="switch"></label><small>需先在 MCP 工具中保存高德 Web 服务 Key 并启用。开启后会将坐标发送给高德，用于坐标转换、附近搜索和步行路线；时间和人均价格缺失时会注明暂缺。</small>
    <div class="row"><button id="care-locate" class="ghost">获取设备位置</button><button id="care-system-location" class="ghost">Windows 位置设置</button></div><small id="care-location-state"></small></div>
    <div class="card form"><div class="row"><h3>看看它会怎么说</h3><button id="care-preview" class="primary">试一次问候</button></div><p id="care-status"></p><p id="care-message"></p></div>
  </section>`;
  document.querySelector("main").insertBefore(host, $("toast"));
  const categories = {
    read: "读取文件和只读工具",
    search: "搜索",
    write: "宠物目录内写入、记忆整理",
    outsideWrite: "宠物目录外写入",
    shell: "Shell 执行",
    install: "安装或启用扩展",
    mcp: "其他 MCP 操作",
  };
  for (const [key, label] of Object.entries(categories)) {
    const row = document.createElement("label");
    row.className = "setting";
    const span = document.createElement("span");
    span.textContent = label;
    const select = document.createElement("select");
    select.id = "policy-" + key;
    for (const [value, text] of [
      ["allow", "允许"],
      ["ask", "询问"],
      ["deny", "禁止"],
    ])
      select.add(new Option(text, value));
    row.append(span, select);
    $("policy-defaults").append(row);
  }
  let page = "",
    policy,
    care,
    selected,
    summaries = [],
    current,
    offset = 0,
    next = null,
    displayed = [],
    polling = false,
    historyBusy = false,
    historyError;
  async function run(id, fn) {
    $(id).disabled = true;
    try {
      return await fn();
    } catch (e) {
      toast(e.message, true);
    } finally {
      $(id).disabled = false;
    }
  }
  function bind(id, fn) {
    $(id).onclick = () => run(id, fn);
  }
  async function historyList() {
    summaries = await api.request("history.list", {
      query: $("history-search").value,
    });
    $("history-list").replaceChildren(
      ...summaries.map(
        (s) =>
          new Option(
            `${s.title} · ${new Date(s.updated).toLocaleDateString()}`,
            s.id,
          ),
      ),
    );
    if (selected) $("history-list").value = selected;
  }
  function renderMessages() {
    const list = $("history-messages"),
      follow = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.replaceChildren(
      ...displayed.map((m) => {
        const row = document.createElement("article");
        row.className = "history-message " + m.role;
        const label = document.createElement("small");
        label.textContent = `${m.role === "user" ? "你" : "宠物"} · ${new Date(m.time).toLocaleString()}${m.status === "complete" ? "" : " · " + ({ streaming: "回复中", error: "失败", cancelled: "已停止" }[m.status] || m.status)}`;
        const text = document.createElement("div");
        text.textContent = m.text;
        row.append(label, text);
        return row;
      }),
    );
    if (follow) list.scrollTop = list.scrollHeight;
    $("history-continue").hidden = selected === current;
    $("history-input").disabled = !selected || selected !== current;
    $("history-send").disabled =
      !selected || selected !== current || historyBusy;
    $("history-stop").hidden = !historyBusy || selected !== current;
    $("history-state").textContent =
      selected === current
        ? historyError || (historyBusy ? "正在回复…" : "当前会话，可直接继续")
        : "历史会话：点击继续后再输入";
    $("history-previous").disabled = offset === 0;
    $("history-next").disabled = next === null;
    $("history-range").textContent = displayed.length
      ? `${offset + 1}—${offset + displayed.length} 条`
      : "还没有消息";
  }
  async function load(id, start) {
    const count = summaries.find((s) => s.id === id)?.count ?? 0;
    const data = await api.request("history.read", {
      id,
      offset: start ?? Math.max(0, count - 20),
    });
    $("history-rename-form").hidden = true;
    selected = id;
    offset = start ?? Math.max(0, count - 20);
    next = data.next;
    displayed = data.messages;
    $("history-title").textContent = data.session.title;
    $("history-list").value = id;
    renderMessages();
    $("history-messages").scrollTop = $("history-messages").scrollHeight;
  }
  async function status() {
    const s = await api.request("history.state");
    current = s.current;
    historyBusy = s.busy;
    historyError = s.error;
    if (selected === current && next === null) {
      const map = new Map(displayed.map((m) => [m.id, m]));
      for (const m of s.messages) map.set(m.id, m);
      displayed = [...map.values()].sort((a, b) => a.time - b.time);
    }
    renderMessages();
  }
  async function lease() {
    await api.request(
      "history.presentation",
      page === "history" && !document.hidden && document.hasFocus(),
    );
  }
  async function openHistory() {
    await lease();
    await status();
    await historyList();
    if (!selected || !summaries.some((s) => s.id === selected))
      selected = current;
    if (selected) await load(selected);
  }
  $("history-list").onchange = () =>
    run("history-continue", () => load($("history-list").value));
  bind("history-search-button", historyList);
  $("history-search").onkeydown = (e) => {
    if (e.key === "Enter") void run("history-search-button", historyList);
  };
  bind("history-new", async () => {
    selected = await api.request("history.new");
    await openHistory();
  });
  bind("history-continue", async () => {
    await api.request("history.select", { id: selected });
    await openHistory();
    $("history-input").focus();
  });
  bind("history-rename", async () => {
    if (!selected) return;
    $("history-new-title").value = $("history-title").textContent;
    $("history-rename-form").hidden = false;
    $("history-new-title").focus();
  });
  bind("history-rename-save", async () => {
    const title = $("history-new-title").value;
    await api.request("history.rename", { id: selected, title });
    await historyList();
    $("history-title").textContent = title;
    $("history-rename-form").hidden = true;
  });
  bind("history-delete", async () => {
    if (selected && confirm("删除这段会话？已形成的日记和核心记忆会保留。")) {
      await api.request("history.remove", { id: selected });
      selected = undefined;
      await openHistory();
    }
  });
  bind("history-previous", () => load(selected, Math.max(0, offset - 20)));
  bind("history-next", () => load(selected, next));
  async function send() {
    const text = $("history-input").value;
    await api.request("history.send", { id: selected, text });
    $("history-input").value = "";
    await historyList();
    await load(selected);
    await status();
  }
  bind("history-send", send);
  bind("history-stop", () => api.request("history.cancel"));
  $("history-input").onkeydown = (e) => {
    if (e.key === "Enter" && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!$("history-send").disabled) void run("history-send", send);
    }
  };
  function renderPolicy() {
    $("policy-mode").value = policy.mode;
    $("policy-auto-note").hidden = policy.mode !== "auto";
    for (const key of Object.keys(categories))
      $("policy-" + key).value = policy.defaults[key];
    $("policy-rules").replaceChildren(
      ...policy.whitelist.map((rule) => {
        const row = document.createElement("div");
        row.className = "extension-row";
        const label = document.createElement("small");
        label.textContent = rule.label;
        const b = document.createElement("button");
        b.textContent = "撤销";
        b.className = "ghost";
        b.onclick = async () => {
          try {
            const latest = await api.request("policy.get");
            policy = await api.request("policy.set", {
              ...latest,
              whitelist: latest.whitelist.filter((r) => r.key !== rule.key),
            });
            renderPolicy();
          } catch (e) {
            toast(e.message, true);
          }
        };
        row.append(label, b);
        return row;
      }),
    );
    if (!policy.whitelist.length)
      $("policy-rules").textContent =
        "还没有白名单。等待确认时可选择记住具体操作。";
  }
  $("policy-mode").onchange = () =>
    ($("policy-auto-note").hidden = $("policy-mode").value !== "auto");
  bind("policy-save", async () => {
    const latest = await api.request("policy.get");
    policy = await api.request("policy.set", {
      ...latest,
      mode: $("policy-mode").value,
      defaults: Object.fromEntries(
        Object.keys(categories).map((k) => [k, $("policy-" + k).value]),
      ),
    });
    renderPolicy();
    toast("权限策略已保存");
  });
  bind("policy-revoke-session", async () => {
    await api.request("policy.resetSession");
    toast("本会话授权已撤销");
  });
  function careValues() {
    if (!care?.settings)
      throw new Error("尚未读取到关怀设置，请确认宠物已连接");
    return {
      enabled: $("care-enabled").checked,
      location: $("care-location").checked,
      nearby: $("care-nearby").checked,
      custom: structuredClone(care.settings.custom),
    };
  }
  function renderCustom() {
    $("care-custom-list").replaceChildren(
      ...care.settings.custom.map((item) => {
        const row = document.createElement("div");
        row.className = "extension-row";
        const label = document.createElement("label");
        label.className = "inline-check";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = item.enabled;
        input.setAttribute("aria-label", "启用 " + item.label);
        const text = document.createElement("span");
        text.textContent = item.label + " · 每天 " + item.time;
        const detail = document.createElement("small");
        detail.textContent = item.prompt;
        const info = document.createElement("div");
        label.append(input, text);
        info.append(label, detail);
        input.onchange = async () => {
          input.disabled = true;
          try {
            const latest = await readCare();
            await api.request("care.set", {
              ...latest.settings,
              custom: latest.settings.custom.map((r) =>
                r.id === item.id ? { ...r, enabled: input.checked } : r,
              ),
            });
            await careStatus();
            renderCustom();
          } catch (e) {
            input.checked = item.enabled;
            toast(e.message, true);
          } finally {
            input.disabled = false;
          }
        };
        const remove = document.createElement("button");
        remove.className = "ghost";
        remove.textContent = "移除";
        remove.onclick = async () => {
          remove.disabled = true;
          try {
            const latest = await readCare();
            await api.request("care.set", {
              ...latest.settings,
              custom: latest.settings.custom.filter((r) => r.id !== item.id),
            });
            await careStatus();
            renderCustom();
          } catch (e) {
            toast(e.message, true);
          } finally {
            remove.disabled = false;
          }
        };
        row.append(info, remove);
        return row;
      }),
    );
    if (!care.settings.custom.length)
      $("care-custom-list").textContent = "还没有自定义提醒。";
  }
  async function readCare() {
    const value = await api.request("care.get");
    if (!value?.settings || !Array.isArray(value.settings.custom))
      throw new Error("宠物与控制器版本不一致，请退出两者后重新启动");
    return value;
  }
  async function careStatus(fill = false) {
    care = await readCare();
    if (fill) {
      for (const key of ["enabled", "location", "nearby"])
        $("care-" + key).checked = care.settings[key];
      renderCustom();
    }
    $("care-status").textContent = care.busy
      ? "正在准备问候…"
      : care.lastError || "设置好模型后，可以试一次。";
    $("care-message").textContent = care.lastMessage || "";
    $("care-location-state").textContent = care.location
      ? `位置来源：${care.location.source} · 精度约 ${Math.round(care.location.accuracy)} 米 · ${new Date(care.location.time).toLocaleTimeString()}`
      : "未取得设备位置；使用普通问候，不通过 IP 推测。";
  }
  async function saveCare() {
    await api.request("care.set", careValues());
    await careStatus();
    $("care-saved").textContent = "已自动保存";
  }
  for (const key of ["enabled", "location", "nearby"])
    $("care-" + key).onchange = () => run("care-" + key, saveCare);
  bind("care-custom-add", async () => {
    const latest = await readCare();
    const item = {
      id: crypto.randomUUID(),
      label: $("care-custom-label").value,
      time: $("care-custom-time").value,
      prompt: $("care-custom-prompt").value,
      enabled: $("care-custom-enabled").checked,
    };
    await api.request("care.set", {
      ...latest.settings,
      custom: [...latest.settings.custom, item],
    });
    $("care-custom-label").value = "";
    $("care-custom-prompt").value = "";
    await careStatus();
    renderCustom();
  });
  bind("care-locate", async () => {
    await saveCare();
    await api.request("care.location");
    await careStatus();
  });
  bind("care-system-location", () => api.request("location.settings"));
  bind("care-preview", async () => {
    await saveCare();
    await api.request("care.preview");
    await careStatus();
  });
  document.addEventListener("visibilitychange", () => {
    if (page === "history") void lease().catch(() => {});
  });
  for (const event of ["focus", "blur"])
    window.addEventListener(event, () => {
      if (page === "history") void lease().catch(() => {});
    });
  window.addEventListener("beforeunload", () => {
    void api.request("history.presentation", false).catch(() => {});
  });
  setInterval(async () => {
    if (polling || document.hidden) return;
    polling = true;
    try {
      if (page === "history") {
        await lease();
        await status();
      } else if (page === "care") await careStatus();
    } catch (e) {
      if (page === "history") $("history-state").textContent = e.message;
    } finally {
      polling = false;
    }
  }, 1200);
  return {
    activate(id) {
      page = id;
      void lease().catch(() => {});
      if (id === "history") void run("history-new", openHistory);
      if (id === "permissions")
        void run("policy-save", async () => {
          policy = await api.request("policy.get");
          renderPolicy();
        });
      if (id === "care") void run("care-enabled", () => careStatus(true));
    },
  };
}
