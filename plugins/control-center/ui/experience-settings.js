export function createExperienceSettings(api, toast) {
  const $ = (id) => document.getElementById(id);
  $("history").innerHTML = `
    <div class="toolbar"><input id="history-search" type="search" placeholder="搜索标题或对话内容" aria-label="搜索对话"><button id="history-search-button" class="quiet">搜索</button><button id="history-new" class="primary">新会话</button></div>
    <div class="split">
      <div class="panel side-list"><select id="history-list" size="18" aria-label="对话列表"></select></div>
      <div class="panel detail">
        <div class="detail-head"><b id="history-title">选择一段对话</b><button id="history-rename" class="quiet">重命名</button><button id="history-delete" class="quiet danger">删除</button></div>
        <div id="history-rename-form" class="inline-field" hidden><input id="history-new-title" maxlength="100" aria-label="会话的新名称"><button id="history-rename-save" class="primary">保存名称</button></div>
        <div class="pager"><button id="history-previous" class="quiet">更早的消息</button><span id="history-range"></span><button id="history-next" class="quiet">更晚的消息</button></div>
        <div id="history-messages" aria-live="polite"></div>
        <details id="history-context" hidden><summary id="history-context-title">会话交接摘要</summary><div id="history-context-body"></div></details>
        <div class="compose">
          <div class="compose-foot"><small id="history-state"></small><button id="history-continue" class="quiet">继续这段对话</button></div>
          <textarea id="history-input" rows="3" placeholder="Enter 换行，Shift + Enter 发送" aria-label="输入消息"></textarea>
          <div id="history-attachments" class="attachments"></div>
          <div class="compose-tools"><button id="history-attach" class="quiet">添加图片或文件</button><button id="history-snapshot" class="quiet">截图</button><button id="history-dictate" class="quiet">语音转文字</button><button id="history-voice-stop" class="quiet">停止语音</button><small id="history-voice-state"></small></div>
          <div class="compose-foot"><small>在此页聊天时，宠物不弹气泡。</small><button id="history-stop" class="quiet">停止回复</button><button id="history-send" class="primary">发送</button></div>
        </div>
      </div>
    </div>`;
  $("permissions").innerHTML = `
    <div class="group"><h3>处理方式</h3><div class="panel panel-form">
      <label class="field">运行模式<select id="policy-mode"><option value="custom">按下面每类操作的设置处理</option><option value="auto">全自动：所有工具操作直接允许</option></select></label>
      <p id="policy-auto-note" class="notice-text" hidden>全自动会直接允许 Shell、写入、安装和外部工具，拥有当前 Windows 用户能访问的全部权限。位置授权仍需单独开启。</p>
    </div></div>
    <div class="group"><h3>每类操作的默认选择</h3><div id="policy-defaults" class="panel"></div>
      <p class="group-note" style="margin-top:10px">工作目录是默认位置，也可以使用绝对路径。白名单精确匹配文件目标，或命令及其参数。本会话授权只对同一工具、同一类操作有效，换会话或重启后失效。</p></div>
    <div class="group"><h3>已记住的白名单</h3><div id="policy-rules" class="panel list"></div></div>
    <div class="page-actions"><button id="policy-revoke-session" class="quiet">撤销本会话的授权</button><button id="policy-save" class="primary">保存权限设置</button></div>`;
  $("care").innerHTML = `
    <div class="group"><div class="group-head"><h3>问候</h3><small id="care-saved" class="save-state"></small></div><div class="panel">
      <label class="row-setting"><div class="row-text"><b>开启主动关怀</b><small>它会在合适的时候自然地问候，结合相处的记忆和最近的对话。你正在聊天时它会等一等。</small></div><input id="care-enabled" type="checkbox" role="switch"></label>
    </div></div>
    <div class="group"><h3>我的提醒</h3><p class="group-note">勾选的提醒每天按时出现。</p><div id="care-custom-list" class="panel list"></div>
      <div class="panel panel-form" style="margin-top:12px">
        <div class="field-grid"><label class="field">提醒名称<input id="care-custom-label" maxlength="60" placeholder="例如：起来走走"></label><label class="field">每天的时间<input id="care-custom-time" type="time" value="15:30"></label></div>
        <label class="field">希望它怎么提醒你<textarea id="care-custom-prompt" rows="3" maxlength="2000" placeholder="例如：提醒我伸展一下，顺便喝点水。"></textarea></label>
        <div class="button-row"><label class="check"><input id="care-custom-enabled" type="checkbox">添加后立即启用</label><button id="care-custom-add" class="primary" style="margin-left:auto">添加提醒</button></div>
      </div></div>
    <div class="group"><h3>位置与附近的去处</h3><div class="panel">
      <label class="row-setting"><div class="row-text"><b>允许读取设备位置</b><small>只使用 Windows 的 GPS、Wi-Fi 或基站定位，不使用 IP 和来源不明的位置。关闭后会清除内存中的位置。</small></div><input id="care-location" type="checkbox" role="switch"></label>
      <label class="row-setting"><div class="row-text"><b>用高德查询附近餐馆</b><small>需要先在 MCP 工具里保存高德 Web 服务 Key 并启用。开启后会把坐标发给高德，用于坐标转换、附近搜索和步行路线。</small></div><input id="care-nearby" type="checkbox" role="switch"></label>
      <div class="row-setting"><div class="row-text"><b>当前位置</b><small id="care-location-state"></small></div><div class="button-row"><button id="care-locate" class="quiet">获取设备位置</button><button id="care-system-location" class="quiet">Windows 位置设置</button></div></div>
    </div></div>
    <div class="group"><h3>试一次</h3><div class="panel panel-form">
      <div class="button-row"><button id="care-preview" class="primary">让它问候一次</button><small id="care-status"></small></div>
      <p id="care-message"></p>
    </div></div>`;
  let attachments = [],
    lastDictation = "",
    voice = {};
  function showAttachments() {
    $("history-attachments").replaceChildren(
      ...attachments.map((a) => {
        const b = document.createElement("button");
        b.className = "quiet";
        b.textContent = a.name + " ×";
        b.title = "移除这个附件";
        b.onclick = () => {
          attachments = attachments.filter((v) => v.id !== a.id);
          showAttachments();
        };
        return b;
      }),
    );
  }
  function addAttachments(items) {
    if (!Array.isArray(items)) items = [items];
    if (attachments.length + items.length > 8)
      throw new Error("最多添加 8 个附件");
    attachments.push(...items);
    showAttachments();
  }
  const categories = {
    read: ["读取文件和只读工具", ""],
    search: ["搜索", ""],
    write: ["写入宠物目录、整理记忆", ""],
    outsideWrite: ["写入宠物目录以外的文件", ""],
    shell: ["执行 Shell 命令", "不是系统沙箱，命令拥有你的用户权限"],
    install: ["安装或启用扩展", ""],
    mcp: ["其它 MCP 工具操作", ""],
  };
  for (const [key, [label, note]] of Object.entries(categories)) {
    const row = document.createElement("label"),
      text = document.createElement("div"),
      b = document.createElement("b"),
      select = document.createElement("select");
    row.className = "row-setting";
    text.className = "row-text";
    b.textContent = label;
    text.append(b);
    if (note) {
      const small = document.createElement("small");
      small.textContent = note;
      text.append(small);
    }
    select.id = "policy-" + key;
    for (const [value, name] of [
      ["allow", "直接允许"],
      ["ask", "先问我"],
      ["deny", "禁止"],
    ])
      select.add(new Option(name, value));
    row.append(text, select);
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
  function empty(target, text) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = text;
    target.replaceChildren(p);
  }
  async function historyList() {
    summaries = await api.request("history.list", {
      query: $("history-search").value,
    });
    $("history-list").replaceChildren(
      ...summaries.map(
        (s) =>
          new Option(
            `${s.title}（${new Date(s.updated).toLocaleDateString()}）`,
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
        const row = document.createElement("article"),
          label = document.createElement("small"),
          text = document.createElement("div");
        row.className = "history-message " + m.role;
        label.textContent = `${m.role === "user" ? "你" : "宠物"}，${new Date(m.time).toLocaleString()}${m.status === "complete" ? "" : "，" + ({ streaming: "回复中", error: "失败", cancelled: "已停止" }[m.status] || m.status)}`;
        text.textContent = m.text;
        row.append(label, text);
        for (const a of m.attachments ?? []) {
          const file = document.createElement("small");
          file.textContent = `附件：${a.name}（${(a.bytes / 1024).toFixed(0)} KB）`;
          row.append(file);
        }
        if (m.role === "assistant" && m.status === "complete") {
          const b = document.createElement("button");
          b.className = "quiet";
          b.textContent = "朗读";
          b.onclick = () =>
            api
              .request("voice.read", { text: m.text })
              .catch((e) => toast(e.message, true));
          row.append(b);
        }
        return row;
      }),
    );
    if (!displayed.length) empty(list, "这段对话还没有消息。");
    if (follow) list.scrollTop = list.scrollHeight;
    const live = !!selected && selected === current;
    $("history-continue").hidden = !selected || live;
    $("history-input").disabled = !live;
    $("history-send").disabled = !live || historyBusy;
    $("history-stop").hidden = !historyBusy || !live;
    $("history-state").textContent = live
      ? historyError || (historyBusy ? "正在回复…" : "当前会话，可以直接继续聊")
      : "这是过去的会话。点“继续这段对话”后再输入。";
    $("history-previous").disabled = offset === 0;
    $("history-next").disabled = next === null;
    // 只有一页时不显示翻页，避免两个永远不可用的按钮。
    $("history-previous").parentElement.hidden = offset === 0 && next === null;
    $("history-range").textContent = displayed.length
      ? `第 ${offset + 1}–${offset + displayed.length} 条`
      : "";
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
    $("history-context").hidden = !data.context;
    $("history-context-title").textContent =
      `会话交接摘要（已压缩 ${data.context?.compactions ?? 0} 次）`;
    const titles = {
      goals: "当前目标",
      constraints: "约束和更正",
      facts: "确认的事实",
      decisions: "已定事项",
      progress: "已完成",
      pending: "待办",
      uncertainties: "待确认",
      artifacts: "文件和来源",
    };
    $("history-context-body").textContent = data.context
      ? Object.entries(titles)
          .map(
            ([key, title]) =>
              `${title}\n${data.context.checkpoint.summary[key].map((s) => "• " + s).join("\n") || "暂无"}`,
          )
          .join("\n\n")
      : "";
    renderMessages();
    $("history-messages").scrollTop = $("history-messages").scrollHeight;
  }
  async function status() {
    const [v, d] = await Promise.all([
      api.request("voice.state"),
      api.request("voice.dictation"),
    ]);
    voice = v;
    $("history-voice-state").textContent = v.message;
    $("history-dictate").textContent = v.dictating ? "结束录音" : "语音转文字";
    if (d && d.target === "history" && d.id !== lastDictation) {
      lastDictation = d.id;
      $("history-input").value +=
        ($("history-input").value ? "\n" : "") + d.text;
    }
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
    if (selected && confirm("删除这段会话？已经写下的日记和核心记忆会保留。")) {
      await api.request("history.remove", { id: selected });
      selected = undefined;
      await openHistory();
    }
  });
  bind("history-previous", () => load(selected, Math.max(0, offset - 20)));
  bind("history-next", () => load(selected, next));
  async function send() {
    const text = $("history-input").value;
    await api.request("history.send", {
      id: selected,
      text,
      attachments: attachments.map((a) => a.id),
    });
    $("history-input").value = "";
    attachments = [];
    showAttachments();
    await historyList();
    await load(selected);
    await status();
  }
  bind("history-send", send);
  bind("history-attach", async () =>
    addAttachments(await api.request("media.choose")),
  );
  bind("history-snapshot", async () =>
    addAttachments(await api.request("media.capture")),
  );
  bind("history-dictate", async () => {
    await api.request(voice.dictating ? "voice.finish" : "voice.dictate", {
      target: "history",
    });
    await status();
  });
  bind("history-voice-stop", () => api.request("voice.stop"));
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
        const row = document.createElement("div"),
          text = document.createElement("div"),
          label = document.createElement("small"),
          actions = document.createElement("div"),
          b = document.createElement("button");
        row.className = "list-row";
        text.className = "list-text";
        actions.className = "list-actions";
        label.textContent = rule.label;
        b.textContent = "撤销";
        b.className = "quiet";
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
        text.append(label);
        actions.append(b);
        row.append(text, actions);
        return row;
      }),
    );
    if (!policy.whitelist.length)
      empty(
        $("policy-rules"),
        "还没有白名单。宠物请你确认时，可以选择“加入白名单”记住具体操作。",
      );
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
    toast("权限设置已保存");
  });
  bind("policy-revoke-session", async () => {
    await api.request("policy.resetSession");
    toast("本会话的授权已撤销");
  });
  function careValues() {
    if (!care?.settings)
      throw new Error("还没有读到关怀设置，请确认宠物已经运行");
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
        const row = document.createElement("div"),
          info = document.createElement("div"),
          label = document.createElement("label"),
          input = document.createElement("input"),
          text = document.createElement("b"),
          detail = document.createElement("small"),
          actions = document.createElement("div"),
          remove = document.createElement("button");
        row.className = "list-row";
        info.className = "list-text";
        label.className = "check";
        actions.className = "list-actions";
        input.type = "checkbox";
        input.checked = item.enabled;
        input.setAttribute("aria-label", "启用 " + item.label);
        text.textContent = `${item.label}，每天 ${item.time}`;
        detail.textContent = item.prompt;
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
        remove.className = "quiet";
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
        actions.append(remove);
        row.append(info, actions);
        return row;
      }),
    );
    if (!care.settings.custom.length)
      empty($("care-custom-list"), "还没有提醒。可以在下面添加。");
  }
  async function readCare() {
    const value = await api.request("care.get");
    if (!value?.settings || !Array.isArray(value.settings.custom))
      throw new Error("宠物和控制器版本不一致，请退出两者后重新启动");
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
      : care.lastError || "需要先在“模型连接”里设置好模型服务。";
    $("care-message").textContent = care.lastMessage || "";
    $("care-location-state").textContent = care.location
      ? `来源：${care.location.source}，精度约 ${Math.round(care.location.accuracy)} 米，${new Date(care.location.time).toLocaleTimeString()} 获取`
      : "还没有设备位置。问候不会通过 IP 猜测你在哪里。";
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
