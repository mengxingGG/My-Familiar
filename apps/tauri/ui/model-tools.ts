import type {
  MobileBridge,
  MobileModelInfo,
  MobileModelInspection,
  MobileModelQuery,
  MobileProviderAdvanced,
  MobileSnapshot,
  ProviderSettings,
} from "../../../packages/mobile-contracts/index.ts";
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) => {
  const el = document.createElement(tag);
  el.textContent = text;
  el.className = className;
  return el;
};
const button = (text: string, action: () => void) => {
  const el = node("button", text, "quiet");
  el.type = "button";
  el.onclick = action;
  return el;
};
const field = (text: string, el: HTMLElement) => {
  const label = node("label", "", "field");
  el.setAttribute("aria-label", text);
  label.append(node("span", text, "field-label"), el);
  return label;
};
const labels = {
  auto: "自动 / 模型默认",
  off: "关闭思考",
  effort: "按强度",
  budget: "按 token 预算",
  adaptive: "自适应思考",
};
const equivalent = (a: unknown, b: unknown): boolean => {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(ordered)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, ordered(v)]),
          )
        : v;
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
};
const sameUrl = (a: string, b: string) => {
  try {
    return (
      new URL(a).href.replace(/\/$/, "") === new URL(b).href.replace(/\/$/, "")
    );
  } catch {
    return false;
  }
};

/** 高级参数只作为当前页面草稿；保存与密钥仍由外层连接表单统一提交。 */
export class ModelTools {
  readonly root = node("section", "", "block model-tools");
  private readonly advanced = node("details", "", "voice-details");
  private readonly controls = node("div", "", "panel panel-form");
  private readonly inputs = new Map<
    string,
    HTMLInputElement | HTMLSelectElement
  >();
  private readonly hint = node("p", "", "block-hint");
  private readonly keyHint = node("p", "", "block-hint");
  private readonly status = node("p", "", "form-status");
  private readonly catalog = node("div", "", "model-catalog");
  private readonly search = node("input");
  private readonly modelList = node("div", "", "model-options");
  private readonly loadButton: HTMLButtonElement;
  private readonly moreButton: HTMLButtonElement;
  private readonly testButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private models: MobileModelInfo[] = [];
  private displayed = 100;
  private info?: MobileModelInspection;
  private infoScope = "";
  private profileStamp = "";
  private snapshot?: MobileSnapshot;
  private currentKind = "";
  private active = false;
  private locked = false;
  private disposed = false;
  private readonly drafts = new Map<string, MobileProviderAdvanced>();
  private scope = "";
  private inspectId = 0;
  private loadId = 0;
  private timer = 0;
  private loading = false;
  private testing = "";
  constructor(
    private readonly bridge: MobileBridge,
    private readonly base: () => Omit<MobileModelQuery, "advanced">,
    private readonly changed: () => void,
    private readonly choose: (id: string) => void,
    private readonly hasTypedKey: () => boolean,
    private readonly inspectionChanged: () => void,
  ) {
    this.root.hidden = true;
    this.advanced.append(node("summary", "高级模型参数"), this.controls);
    this.status.setAttribute("role", "status");
    const number = (
      name: string,
      title: string,
      min: number,
      max: number,
      step = "1",
      placeholder = "",
    ) => {
      const el = node("input");
      el.type = "number";
      el.min = String(min);
      el.max = String(max);
      el.step = step;
      el.placeholder = placeholder;
      this.inputs.set(name, el);
      this.controls.append(field(title, el));
      return el;
    };
    number("temperature", "温度（留空使用模型默认）", 0, 2, "0.1", "默认");
    number("topP", "Top P（留空使用模型默认）", 0.01, 1, "0.01", "默认");
    number("maxOutputTokens", "最大输出 token", 128, 262144);
    number(
      "contextTokens",
      "上下文窗口（留空自动识别）",
      1024,
      2097152,
      "1",
      "自动",
    );
    number("autoCompactPercent", "自动压缩阈值（%）", 10, 95);
    number("timeoutSeconds", "请求超时（秒）", 10, 900);
    const select = (
      name: string,
      title: string,
      items: Record<string, string>,
    ) => {
      const el = node("select");
      for (const [value, text] of Object.entries(items)) {
        const option = node("option", text);
        option.value = value;
        el.append(option);
      }
      this.inputs.set(name, el);
      this.controls.append(field(title, el));
      return el;
    };
    select("mode", "思考模式", labels);
    select(
      "effort",
      "思考强度",
      Object.fromEntries(
        ["none", "minimal", "low", "medium", "high", "xhigh", "max"].map(
          (v) => [v, v],
        ),
      ),
    );
    number("budgetTokens", "思考 token 预算", 1, 262144);
    const cache = node("input");
    cache.type = "checkbox";
    this.inputs.set("cache", cache);
    const cacheLabel = node("label", "使用提供方支持的提示缓存", "voice-check");
    cacheLabel.prepend(cache);
    this.controls.append(cacheLabel, this.hint);
    this.controls.addEventListener("input", () => {
      this.drafts.set(this.currentKind, this.read()!);
      this.changed();
      this.edit();
    });
    this.search.type = "search";
    this.search.placeholder = "搜索模型名称或 ID";
    this.search.setAttribute("aria-label", "搜索模型");
    this.search.oninput = () => {
      this.displayed = 100;
      this.renderModels();
    };
    this.loadButton = button("获取模型列表", () => void this.load());
    this.moreButton = button("显示更多模型", () => {
      this.displayed += 100;
      this.renderModels();
    });
    this.catalog.append(this.search, this.modelList, this.moreButton);
    this.catalog.hidden = true;
    this.testButton = button("测试已保存连接", () => void this.test());
    this.cancelButton = button("停止连接测试", () => void this.cancel());
    this.cancelButton.hidden = true;
    const actions = node("div", "", "model-actions");
    actions.append(this.loadButton, this.testButton, this.cancelButton);
    this.root.append(
      actions,
      this.keyHint,
      this.status,
      this.catalog,
      this.advanced,
      node(
        "p",
        "测试仅向已保存服务发送固定测试句，不附带聊天或记忆。高级参数与上方连接一起保存。",
        "block-hint",
      ),
    );
  }
  read(): MobileProviderAdvanced | undefined {
    if (!this.snapshot?.modelManagement) return;
    const value = (key: string) => this.inputs.get(key)!.value,
      nullable = (key: string) =>
        value(key).trim() === "" ? null : Number(value(key));
    return {
      temperature: nullable("temperature"),
      topP: nullable("topP"),
      maxOutputTokens: Number(value("maxOutputTokens")),
      contextTokens: nullable("contextTokens"),
      autoCompactPercent: Number(value("autoCompactPercent")),
      timeoutSeconds: Number(value("timeoutSeconds")),
      thinking: {
        mode: value("mode") as MobileProviderAdvanced["thinking"]["mode"],
        effort: value("effort"),
        budgetTokens: Number(value("budgetTokens")),
      },
      cache: (this.inputs.get("cache") as HTMLInputElement).checked,
    };
  }
  private paint(p: MobileProviderAdvanced) {
    for (const key of [
      "temperature",
      "topP",
      "maxOutputTokens",
      "contextTokens",
      "autoCompactPercent",
      "timeoutSeconds",
    ] as const)
      this.inputs.get(key)!.value = p[key] === null ? "" : String(p[key]);
    for (const key of ["mode", "effort", "budgetTokens"] as const)
      this.inputs.get(key)!.value = String(p.thinking[key]);
    (this.inputs.get("cache") as HTMLInputElement).checked = p.cache;
  }
  sync(
    s: MobileSnapshot,
    profile: ProviderSettings,
    open: boolean,
    locked: boolean,
  ) {
    this.snapshot = s;
    this.active = open;
    this.locked = locked;
    this.root.hidden = !s.modelManagement || !profile.advanced;
    if (this.root.hidden) return;
    const kind = this.base().kind,
      changed = kind !== this.currentKind;
    if (changed) {
      this.currentKind = kind;
      this.info = undefined;
      this.paint(this.drafts.get(kind) ?? profile.advanced!);
      this.edit();
    } else if (!this.drafts.has(kind)) this.paint(profile.advanced!);
    const stamp = `${kind}|${profile.baseUrl}|${profile.keyConfigured}`;
    if (stamp !== this.profileStamp) {
      this.profileStamp = stamp;
      this.loadId++;
      if (this.loading) this.status.textContent = "连接设置已更新，请重新获取模型列表。";
      this.loading = false;
      this.models = [];
      this.info = undefined;
      this.renderModels();
      this.edit();
    }
    this.local();
  }
  knownKey(): boolean | undefined {
    const q = this.base();
    return this.infoScope === `${q.kind}|${q.baseUrl}`
      ? this.info?.hasKey
      : undefined;
  }
  reset() {
    this.drafts.clear();
    this.currentKind = "";
    this.status.textContent = "";
    this.info = undefined;
    this.models = [];
    this.renderModels();
  }
  close() {
    this.active = false;
    this.inspectId++;
    this.loadId++;
    this.loading = false;
    clearTimeout(this.timer);
    if (this.testing) void this.cancel();
  }
  dispose() {
    this.disposed = true;
    this.close();
    this.drafts.clear();
  }
  saved(kind: string, advanced: MobileProviderAdvanced | undefined) {
    if (equivalent(this.drafts.get(kind), advanced)) this.drafts.delete(kind);
    this.loadId++;
    this.loading = false;
    this.models = [];
    this.info = undefined;
    this.renderModels();
    this.edit();
  }
  edit() {
    if (!this.active || !this.snapshot?.modelManagement) return;
    this.inspectId++;
    const q = this.base(),
      scope = `${q.kind}|${q.baseUrl}`;
    if (scope !== this.scope) {
      this.scope = scope;
      this.loadId++;
      if (this.loading) this.status.textContent = "";
      this.loading = false;
      this.models = [];
      this.info = undefined;
      this.hint.textContent = "";
      this.renderModels();
    }
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.inspect(), 200);
    this.local();
  }
  private query(): MobileModelQuery {
    return { ...this.base(), advanced: this.read() };
  }
  private local() {
    const enabled = this.active && !this.root.hidden;
    this.loadButton.disabled =
      !enabled || this.loading || this.locked || this.hasTypedKey();
    const q = this.query(),
      saved = this.snapshot?.provider;
    const unchanged =
      !!saved &&
      saved.kind === q.kind &&
      sameUrl(saved.baseUrl, q.baseUrl) &&
      saved.model === q.model &&
      equivalent(saved.advanced, q.advanced) &&
      !this.hasTypedKey();
    this.testButton.disabled =
      !enabled ||
      this.locked ||
      !!this.testing ||
      !unchanged ||
      !q.model.trim();
    this.cancelButton.hidden = !this.testing;
    this.keyHint.textContent = this.hasTypedKey()
      ? "请先保存输入的密钥，再获取列表或测试。"
      : this.info?.hasKey
        ? "当前类型与地址已有密钥。"
        : this.info
          ? "当前类型与地址没有密钥，本地或兼容服务可能不需要。"
          : "模型列表使用当前类型、地址已经保存的密钥。";
    for (const input of this.inputs.values()) input.disabled = this.locked;
    const mode = this.inputs.get("mode")!.value;
    this.inputs.get("effort")!.parentElement!.hidden = ![
      "effort",
      "adaptive",
    ].includes(mode);
    this.inputs.get("budgetTokens")!.parentElement!.hidden = mode !== "budget";
    if (this.info) {
      for (const option of (this.inputs.get("mode") as HTMLSelectElement)
        .options)
        option.disabled = !this.info.options.modes.includes(
          option.value as MobileProviderAdvanced["thinking"]["mode"],
        );
      for (const option of (this.inputs.get("effort") as HTMLSelectElement)
        .options)
        option.disabled = !this.info.options.efforts.includes(option.value);
    }
  }
  private async inspect() {
    const id = ++this.inspectId,
      q = this.query();
    try {
      const info = await this.bridge.request("provider.inspect", q);
      if (id !== this.inspectId || !this.active || this.disposed) return;
      this.info = info;
      this.infoScope = `${q.kind}|${q.baseUrl}`;
      this.inspectionChanged();
      const m = info.model;
      this.hint.textContent = `${info.options.hint} ${m?.contextWindow ? `模型报告窗口 ${m.contextWindow} token。` : m?.inputLimit ? `模型报告输入上限 ${m.inputLimit} token。` : "未报告窗口时暂按 32768 token 计算；这不是官方最大值。"}${m?.outputLimit ? ` 输出上限 ${m.outputLimit} token。` : ""}`;
      this.local();
    } catch {
      if (id === this.inspectId && this.active)
        this.hint.textContent = "参数或地址暂时无效，请检查填写内容。";
    }
  }
  private renderModels() {
    const q = this.search.value.trim().toLowerCase(),
      items = this.models.filter((m) =>
        `${m.id} ${m.name}`.toLowerCase().includes(q),
      );
    this.modelList.replaceChildren(
      ...items.slice(0, this.displayed).map((m) => {
        const el = button(
          m.name === m.id ? m.id : `${m.name} · ${m.id}`,
          () => {
            this.choose(m.id);
            this.edit();
          },
        );
        el.className = "model-option";
        el.setAttribute("aria-label", `选择模型 ${m.id}`);
        return el;
      }),
    );
    this.moreButton.hidden = items.length <= this.displayed;
    this.catalog.hidden = !this.models.length;
  }
  private async load() {
    if (this.loading || this.hasTypedKey()) return;
    const id = ++this.loadId,
      q = this.base();
    this.loading = true;
    this.status.textContent = "正在获取模型列表…";
    this.local();
    try {
      const result = await this.bridge.request("provider.models", {
        ...q,
        refresh: true,
      });
      if (id !== this.loadId || !this.active || this.disposed) return;
      this.models = result.items;
      this.displayed = 100;
      this.renderModels();
      this.status.textContent = result.items.length
        ? `已获取 ${result.items.length} 个模型，点击名称填入；仍需保存才会改用。`
        : "服务未返回模型，仍可手动填写 ID。";
      void this.inspect();
    } catch {
      if (id === this.loadId && this.active)
        this.status.textContent =
          "未能获取模型列表，请检查地址与已保存密钥；仍可手动填写 ID。";
    } finally {
      if (id === this.loadId) {
        this.loading = false;
        this.local();
      }
    }
  }
  private async test() {
    if (this.testing) return;
    const id = crypto.randomUUID(),
      query = this.query();
    this.testing = id;
    this.status.textContent = "正在发送固定测试句…";
    this.local();
    try {
      const result = await this.bridge.request("provider.test", {
        ...query,
        operationId: id,
      });
      if (this.testing === id && this.active && equivalent(this.query(), query))
        this.status.textContent = `连接成功，模型已返回文字（${(result.elapsedMs / 1000).toFixed(1)} 秒）。`;
    } catch (error) {
      if (this.testing === id && this.active && equivalent(this.query(), query))
        this.status.textContent =
          (error as { code?: string }).code === "CANCELLED"
            ? "连接测试已停止。"
            : "连接测试未成功，请检查已保存配置后重试。";
    } finally {
      if (this.testing === id) {
        this.testing = "";
        this.local();
      }
    }
  }
  private async cancel() {
    const id = this.testing;
    if (!id) return;
    try {
      await this.bridge.request("provider.test.cancel", { operationId: id });
      if (this.testing === id) {
        this.testing = "";
        this.status.textContent = "连接测试已停止。";
        this.local();
      }
    } catch {
      if (this.active)
        this.status.textContent = "尚未确认测试已停止，最多 20 秒自动超时。";
    }
  }
}
