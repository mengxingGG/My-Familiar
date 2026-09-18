const $ = (id) => document.getElementById(id);
const labels = {
  auto: "自动 / 模型默认",
  off: "关闭思考",
  effort: "按强度",
  budget: "按 token 预算",
  adaptive: "自适应思考",
};
export function createModelSettings(api, markDirty, toast) {
  let providers = [],
    drafts = {},
    current = "",
    catalog = [],
    signature = "",
    revision = 0,
    loadRevision = 0,
    loading = false,
    active = false,
    inspection;
  const read = () => ({
    kind: $("provider-kind").value,
    baseUrl: $("base-url").value.trim(),
    model: $("model-id").value.trim(),
    temperature: $("temperature-auto").checked
      ? null
      : Number($("temperature").value),
    topP: $("top-p-auto").checked ? null : Number($("top-p").value),
    maxOutputTokens: Number($("max-output").value),
    contextTokens: $("context-tokens").value
      ? Number($("context-tokens").value)
      : null,
    timeoutSeconds: Number($("request-timeout").value),
    thinking: {
      mode: $("thinking-mode").value || "auto",
      effort: $("thinking-effort").value || "medium",
      budgetTokens: Number($("thinking-budget").value),
    },
    cache: $("prompt-cache").checked,
  });
  function selectOptions(id, values, label, selected) {
    $(id).replaceChildren(
      ...values.map((v) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = label(v);
        return o;
      }),
    );
    $(id).value = values.includes(selected) ? selected : (values[0] ?? "");
  }
  function paint(c) {
    current = c.kind;
    $("provider-kind").value = c.kind;
    $("base-url").value = c.baseUrl;
    $("model-id").value = c.model;
    $("temperature-auto").checked = c.temperature === null;
    $("temperature").value = c.temperature ?? 0.7;
    $("top-p-auto").checked = c.topP === null;
    $("top-p").value = c.topP ?? 1;
    $("max-output").value = c.maxOutputTokens;
    $("context-tokens").value = c.contextTokens ?? "";
    $("request-timeout").value = c.timeoutSeconds;
    $("thinking-budget").value = c.thinking.budgetTokens;
    $("prompt-cache").checked = c.cache;
    selectOptions(
      "thinking-mode",
      Object.keys(labels),
      (v) => labels[v],
      c.thinking.mode,
    );
    selectOptions(
      "thinking-effort",
      ["minimal", "low", "medium", "high", "xhigh", "max"],
      (v) => v,
      c.thinking.effort,
    );
    $("api-key").value = "";
    $("model-search").value = "";
    catalog = [];
    renderModels();
    localControls();
  }
  function localControls() {
    const mode = $("thinking-mode").value;
    $("effort-row").hidden = !["effort", "adaptive"].includes(mode);
    $("budget-row").hidden = mode !== "budget";
    $("temperature").disabled =
      $("temperature-auto").checked ||
      inspection?.options.temperature === false;
    $("top-p").disabled =
      $("top-p-auto").checked || inspection?.options.topP === false;
  }
  function applyInspection(value) {
    inspection = value;
    const c = read(),
      o = value.options;
    selectOptions("thinking-mode", o.modes, (v) => labels[v], c.thinking.mode);
    selectOptions("thinking-effort", o.efforts, (v) => v, c.thinking.effort);
    if (!o.temperature) $("temperature-auto").checked = true;
    if (!o.topP) $("top-p-auto").checked = true;
    $("temperature-auto").disabled = !o.temperature;
    $("top-p-auto").disabled = !o.topP;
    $("temperature").max = o.temperatureMax;
    $("top-p").min = Math.max(0.01, o.topPMin);
    $("thinking-budget").min = o.budgetMin;
    $("thinking-budget").max = o.budgetMax ?? 262144;
    $("parameter-hint").textContent = o.hint;
    $("key-status").textContent = value.hasKey
      ? "此供应商和地址已保存密钥（系统加密）；留空保留。"
      : "此供应商和地址尚无密钥；本地/兼容服务可不填。";
    const m = value.model;
    $("context-hint").textContent = m?.contextWindow
      ? `模型报告上下文窗口 ${m.contextWindow.toLocaleString()} token；输出上限 ${m.outputLimit?.toLocaleString() ?? "未报告"}。`
      : m?.inputLimit
        ? `模型报告输入上限 ${m.inputLimit.toLocaleString()} token；输出上限 ${m.outputLimit?.toLocaleString() ?? "未报告"}。`
        : "模型列表未提供上限时暂用 32768；可按官方模型说明手动填写，暂用值不是官方最大值。";
    localControls();
  }
  async function inspect() {
    const rev = ++revision;
    try {
      const value = await api.request("provider.inspect", { config: read() });
      if (rev === revision) applyInspection(value);
      return rev === revision ? value : undefined;
    } catch (e) {
      if (rev === revision) $("parameter-hint").textContent = e.message;
    }
  }
  function renderModels() {
    const q = $("model-search").value.trim().toLowerCase(),
      selected = $("model-id").value;
    const filtered = catalog.filter((m) =>
      `${m.id} ${m.name}`.toLowerCase().includes(q),
    );
    $("model-list").replaceChildren(
      ...filtered.map((m) => {
        const o = document.createElement("option");
        o.value = m.id;
        o.textContent = m.name === m.id ? m.id : `${m.name} · ${m.id}`;
        return o;
      }),
    );
    $("model-list").value = selected;
  }
  async function load(refresh = false) {
    if (!current) return;
    const selected = read(),
      config = {
        ...providers.find((p) => p.id === selected.kind).defaults,
        baseUrl: selected.baseUrl,
        model: selected.model,
      },
      scope = `${config.kind}|${config.baseUrl}`,
      rev = ++loadRevision;
    loading = true;
    $("load-models").disabled = true;
    $("models-status").textContent = "正在获取模型列表…";
    try {
      const info = await api.request("provider.inspect", { config });
      if (rev !== loadRevision) return;
      $("key-status").textContent = info.hasKey
        ? "此服务已保存密钥（系统加密）。"
        : "此服务尚无密钥。";
      const p = providers.find((p) => p.id === config.kind);
      if (p?.requiresKey && !info.hasKey) {
        await inspect();
        $("models-status").textContent =
          "保存 API Key 后自动获取模型列表；也可手动填写 ID。";
        return;
      }
      const result = await api.request("provider.models", { config, refresh });
      if (rev !== loadRevision || scope !== `${read().kind}|${read().baseUrl}`)
        return;
      catalog = result;
      renderModels();
      $("models-status").textContent = result.length
        ? `已获取 ${result.length} 个模型；列表不保证每个模型都支持文字聊天。`
        : "服务未返回可用模型，可手动填写 ID。";
      await inspect();
    } catch (e) {
      if (rev === loadRevision)
        $("models-status").textContent = `${e.message}。仍可手动填写模型 ID。`;
    } finally {
      if (rev === loadRevision) {
        loading = false;
        $("load-models").disabled = false;
      }
    }
  }
  $("provider-kind").onchange = () => {
    if (current) drafts[current] = readWithKind(current);
    inspection = undefined;
    paint(
      drafts[$("provider-kind").value] ??
        providers.find((p) => p.id === $("provider-kind").value).defaults,
    );
    signature = "";
    markDirty();
    void load();
  };
  function readWithKind(kind) {
    return { ...read(), kind };
  }
  $("base-url").onchange = () => {
    revision++;
    $("api-key").value = "";
    catalog = [];
    renderModels();
    void load();
  };
  $("model-search").oninput = renderModels;
  $("model-list").onchange = () => {
    $("model-id").value = $("model-list").value;
    markDirty();
    void inspect();
  };
  $("model-id").onchange = () => {
    markDirty();
    void inspect();
  };
  $("thinking-mode").onchange = () => {
    localControls();
    void inspect();
  };
  for (const id of ["temperature-auto", "top-p-auto"])
    $(id).onchange = localControls;
  $("load-models").onclick = () => void load(true);
  $("save-key").onclick = async () => {
    if (!$("api-key").value) {
      toast("请输入密钥；删除请使用下方按钮");
      return;
    }
    const c = read(),
      key = $("api-key").value;
    $("save-key").disabled = true;
    $("save-key").dataset.pending = "true";
    try {
      await api.request("secret.set", { config: c, key });
      $("api-key").value = "";
      toast("当前服务密钥已加密保存");
      await load(true);
    } catch (e) {
      toast(e.message, true);
    } finally {
      delete $("save-key").dataset.pending;
      $("save-key").disabled = false;
    }
  };
  $("delete-key").onclick = async () => {
    if (!confirm("删除当前供应商和地址的密钥？")) return;
    try {
      await api.request("secret.set", { config: read(), key: "" });
      toast("当前服务密钥已删除");
      await inspect();
    } catch (e) {
      toast(e.message, true);
    }
  };
  return {
    read,
    fill(config, list) {
      providers = list;
      drafts = { ...config.savedProfiles, ...drafts, [config.kind]: config };
      const next = JSON.stringify(config);
      if (signature === next) return;
      signature = next;
      selectOptions(
        "provider-kind",
        providers.map((p) => p.id),
        (id) => providers.find((p) => p.id === id).name,
        config.kind,
      );
      inspection = undefined;
      paint(config);
      void inspect();
      if (active) void load();
    },
    activate() {
      active = true;
      if (!loading) void load();
    },
    usage(s) {
      if (!s) {
        $("session-status").textContent =
          "会话尚未开始。历史只在接近上下文上限时裁剪。";
        return;
      }
      const u = s.usage;
      const fmt = (v) => (v === undefined ? "未报告" : v.toLocaleString());
      $("session-status").textContent =
        `会话 ${s.id.slice(0, 8)} · 前缀版本 ${s.epoch} · 保留 ${s.retainedMessages} 条消息\n输入${s.exact ? "计数" : "保守估算"} ${fmt(s.inputTokens)} / ${fmt(s.inputBudget)} token · 上限来源：${{ model: "模型目录", manual: "手动设置", fallback: "暂用值" }[s.limitSource]}\n服务端用量：输入 ${fmt(u?.inputTokens)} · 输出 ${fmt(u?.outputTokens)} · 缓存命中 ${fmt(u?.cachedInputTokens)} · 缓存写入 ${fmt(u?.cacheWriteTokens)}\n已移出最旧消息 ${s.trimmedMessages} 条；实际节省金额由供应商计费决定。`;
    },
  };
}
