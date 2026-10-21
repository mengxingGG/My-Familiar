import type {
  MobileBridge,
  MobileCareState,
  MobileCareSettings,
} from "../../../packages/mobile-contracts/index.ts";
type Confirm = {
  title: string;
  body: string;
  confirmLabel: string;
  action: () => Promise<unknown>;
  done: string;
  tone?: "danger" | "primary";
};
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  cls = "",
) => {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = cls;
  return n;
};
const button = (text: string, run: () => void, cls = "quiet") => {
  const b = el("button", text, cls);
  b.type = "button";
  b.addEventListener("click", run);
  return b;
};
const label = (text: string, n: HTMLElement) => {
  const l = el("label", "", "field");
  n.setAttribute("aria-label", text);
  l.append(el("span", text, "field-label"), n);
  return l;
};
const check = (text: string) => {
  const n = el("input");
  n.type = "checkbox";
  const l = el("label", "", "voice-check");
  l.append(n, document.createTextNode(text));
  return { input: n, label: l };
};
const error = (e: unknown) =>
  ({
    CONFLICT: "设置已变化，草稿已保留。请重新读取后核对。",
    CANCELLED: "定位已取消。",
    BUSY: "正在处理，请稍后再试。",
    INVALID_INPUT: "请核对提醒内容，并先保存可用的模型设置。",
    UNAVAILABLE: "暂时不可用。请确认位置权限、系统定位开关，并保持页面在前台。",
  })[(e as { code?: string })?.code ?? ""] ?? "操作未确认，请重新读取后核对。";

export class CareView {
  readonly page = el("section", "", "page care-page");
  readonly heading = el("h1", "日常关怀");
  private body = el("div", "", "page-body care-body");
  private form = el("form", "", "panel panel-form");
  private notice = el("p", "", "form-status");
  private status = el("p", "", "block-hint");
  private result = el("pre", "", "library-source care-result");
  private reminders = el("div", "", "care-reminders");
  private enabled = check("开启日常关怀与自定义提醒");
  private location = check("允许关怀使用最近获取的大致位置");
  private nearby = check("在午间、晚间问候中附上附近建议");
  private save: HTMLButtonElement;
  private reload: HTMLButtonElement;
  private preview: HTMLButtonElement;
  private stop: HTMLButtonElement;
  private locate: HTMLButtonElement;
  private cancel: HTMLButtonElement;
  private permission: HTMLButtonElement;
  private add: HTMLButtonElement;
  private state?: MobileCareState;
  private draft?: MobileCareSettings;
  private revision = "";
  private dirty = false;
  private edits = 0;
  private pending = false;
  private active = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private locating?: string;
  constructor(
    private bridge: MobileBridge,
    back: HTMLButtonElement,
    private confirm: (v: Confirm) => void,
  ) {
    this.page.hidden = true;
    this.heading.id = "care-heading";
    this.heading.tabIndex = -1;
    this.page.setAttribute("aria-labelledby", this.heading.id);
    const bar = el("header", "", "pagebar");
    bar.append(back, this.heading);
    this.page.append(bar, this.body);
    this.save = button("保存关怀设置", () => {}, "primary");
    this.save.type = "submit";
    this.reload = button("重新读取关怀设置", () => this.reloadNow());
    this.preview = button(
      "现在问候我",
      () => void this.action("care.preview"),
      "primary",
    );
    this.stop = button("停止生成关怀", () => void this.action("care.stop"));
    this.permission = button("位置权限与系统设置", () => {
      void this.bridge
        .request("capability.request", { id: "location" })
        .catch((e) => (this.notice.textContent = error(e)));
    });
    this.locate = button("刷新大致位置", () => void this.locateNow());
    this.cancel = button("取消定位", () => void this.cancelLocation());
    this.add = button("添加自定义提醒", () => {
      if (!this.draft || this.draft.custom.length >= 30) return;
      this.draft.custom.push({
        id: crypto.randomUUID(),
        label: "",
        prompt: "",
        time: "12:00",
        enabled: true,
      });
      this.changed();
      this.renderReminders();
    });
    const actions = el("div", "", "care-actions");
    actions.append(this.save, this.reload);
    const previewActions = el("div", "", "care-actions");
    previewActions.append(this.preview, this.stop);
    const locationActions = el("div", "", "care-actions");
    locationActions.append(this.permission, this.locate, this.cancel);
    this.form.append(
      this.enabled.label,
      el(
        "p",
        "启动、上午、午间、晚间自然问候；普通问候在 22:00–08:00 安静，自定义提醒按设定时间运行。需开启常驻宠物并配置模型，可能产生模型费用。系统休眠或回收可能延迟提醒，不作为准点闹钟。",
        "block-hint",
      ),
      this.location.label,
      this.nearby.label,
      el(
        "p",
        "位置需在此页手动刷新，仅在内存保留 10 分钟；离开前台会停止定位，不持续追踪。开启附近建议后，会把此位置交给已配置并启用的高德服务查询；精度不足时不估算步行时间。",
        "block-hint",
      ),
      locationActions,
      this.status,
      el("h2", "自定义提醒", "block-title"),
      this.reminders,
      this.add,
      actions,
    );
    this.body.append(
      this.notice,
      this.form,
      previewActions,
      el("h2", "上次关怀", "block-title"),
      this.result,
    );
    this.notice.setAttribute("role", "status");
    this.status.setAttribute("role", "status");
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveNow();
    });
    this.enabled.input.addEventListener("input", () => {
      if (this.draft) {
        this.draft.enabled = this.enabled.input.checked;
        this.changed();
      }
    });
    this.location.input.addEventListener("input", () => {
      if (this.draft) {
        this.draft.location = this.location.input.checked;
        if (!this.draft.location) {
          this.draft.nearby = false;
          this.nearby.input.checked = false;
        }
        this.changed();
      }
    });
    this.nearby.input.addEventListener("input", () => {
      if (this.draft) {
        this.draft.nearby = this.nearby.input.checked;
        this.changed();
      }
    });
  }
  open() {
    this.active = true;
    void this.refresh();
  }
  close() {
    this.active = false;
    this.generation++;
    clearTimeout(this.timer);
    void this.cancelLocation();
  }
  dispose() {
    this.close();
  }
  private changed() {
    this.dirty = true;
    this.edits++;
    this.notice.textContent = "有未保存的修改。";
    this.controls();
  }
  private accept(s: MobileCareState) {
    this.state = s;
    if (!this.dirty) {
      this.draft = structuredClone(s.settings);
      this.revision = s.revision;
      this.renderForm();
    }
    this.controls();
  }
  private async refresh() {
    clearTimeout(this.timer);
    const ticket = ++this.generation;
    try {
      const s = await this.bridge.request("care.get", undefined);
      if (this.active && ticket === this.generation) this.accept(s);
    } catch (e) {
      if (this.active && ticket === this.generation)
        this.notice.textContent = error(e);
    } finally {
      if (this.active && ticket === this.generation)
        this.timer = setTimeout(() => void this.refresh(), 2000);
    }
  }
  private renderForm() {
    if (!this.draft) return;
    this.enabled.input.checked = this.draft.enabled;
    this.location.input.checked = this.draft.location;
    this.nearby.input.checked = this.draft.nearby;
    this.renderReminders();
  }
  private renderReminders() {
    this.reminders.replaceChildren();
    for (const [i, r] of (this.draft?.custom ?? []).entries()) {
      const box = el("fieldset", "", "care-reminder");
      box.append(el("legend", `提醒 ${i + 1}`));
      const enabled = check(`启用提醒 ${i + 1}`);
      enabled.input.checked = r.enabled;
      enabled.input.addEventListener("input", () => {
        r.enabled = enabled.input.checked;
        this.changed();
      });
      const title = el("input");
      title.type = "text";
      title.maxLength = 60;
      title.required = true;
      title.value = r.label;
      title.addEventListener("input", () => {
        r.label = title.value;
        this.changed();
      });
      const time = el("input");
      time.type = "time";
      time.required = true;
      time.value = r.time;
      time.addEventListener("input", () => {
        r.time = time.value;
        this.changed();
      });
      const prompt = el("textarea");
      prompt.maxLength = 2000;
      prompt.required = true;
      prompt.rows = 3;
      prompt.value = r.prompt;
      prompt.addEventListener("input", () => {
        r.prompt = prompt.value;
        this.changed();
      });
      const remove = button(
        `移除提醒 ${i + 1}`,
        () =>
          this.confirm({
            title: `移除“${r.label || "未命名提醒"}”？`,
            body: "保存关怀设置后生效。",
            confirmLabel: "移除",
            done: "已从草稿移除，请保存设置。",
            action: async () => {
              if (this.draft) {
                this.draft.custom = this.draft.custom.filter(
                  (x) => x.id !== r.id,
                );
                this.changed();
                this.renderReminders();
              }
            },
          }),
        "quiet danger",
      );
      box.append(
        enabled.label,
        label(`提醒 ${i + 1} 名称`, title),
        label(`提醒 ${i + 1} 时间`, time),
        label(`提醒 ${i + 1} 内容`, prompt),
        remove,
      );
      this.reminders.append(box);
    }
  }
  private controls() {
    const s = this.state,
      locked = this.pending || !!this.locating;
    this.form.hidden = !this.draft;
    this.save.disabled = locked;
    this.reload.disabled = locked;
    this.add.disabled = locked || !this.draft || this.draft.custom.length >= 30;
    this.nearby.input.disabled = !this.draft?.location;
    this.preview.disabled = locked || this.dirty || !s || s.busy;
    this.stop.hidden = !s?.busy;
    this.stop.disabled = this.pending;
    this.locate.disabled =
      locked || this.dirty || !s?.settings.location || !s.locationPermission;
    this.permission.disabled = locked;
    this.cancel.hidden = !this.locating;
    this.status.textContent = this.locating
      ? "正在获取大致位置…"
      : !s
        ? "正在读取…"
        : !s.locationPermission
          ? "尚未授权大致位置。"
          : !s.locationEnabled
            ? "系统定位已关闭，请在系统设置中开启。"
            : s.location
              ? `${s.location.mock ? "模拟位置 · " : ""}已获取大致位置，误差约 ${Math.ceil(s.location.accuracy)} 米；${new Date(s.location.time).toLocaleTimeString()} 更新。`
              : "暂无有效位置，请刷新；关怀仍可普通问候。";
    this.result.textContent =
      (s?.busy ? "正在生成关怀…\n\n" : "") +
      (s?.lastMessage ?? "还没有关怀记录。") +
      (s?.lastError ? "\n\n" + s.lastError : "");
  }
  private async saveNow() {
    if (!this.draft || this.pending || this.locating) return;
    const edits = this.edits;
    this.pending = true;
    this.generation++;
    clearTimeout(this.timer);
    this.controls();
    try {
      const s = await this.bridge.request("care.save", {
        settings: structuredClone(this.draft),
        revision: this.revision,
      });
      this.revision = s.revision;
      if (this.edits === edits) this.dirty = false;
      this.accept(s);
      this.notice.textContent = this.dirty
        ? "设置已保存，之后的编辑尚未保存。"
        : "关怀设置已保存。";
    } catch (e) {
      this.notice.textContent = error(e);
    } finally {
      this.pending = false;
      this.controls();
      if (this.active) void this.refresh();
    }
  }
  private reloadNow() {
    const run = async () => {
      this.dirty = false;
      await this.refresh();
    };
    if (this.dirty)
      this.confirm({
        title: "重新读取关怀设置？",
        body: "尚未保存的修改将被替换。",
        confirmLabel: "重新读取",
        done: "已读取关怀设置。",
        action: run,
      });
    else void run();
  }
  private async action(method: "care.preview" | "care.stop") {
    this.pending = true;
    this.generation++;
    clearTimeout(this.timer);
    this.controls();
    try {
      this.accept(await this.bridge.request(method, undefined));
      this.notice.textContent =
        method === "care.stop"
          ? "已请求停止生成。"
          : "正在生成，完成后会记入当前对话。";
    } catch (e) {
      this.notice.textContent = error(e);
    } finally {
      this.pending = false;
      this.controls();
      if (this.active) void this.refresh();
    }
  }
  private async locateNow() {
    if (!this.state || this.pending || this.locating || this.dirty) return;
    const operationId = crypto.randomUUID();
    this.locating = operationId;
    this.controls();
    try {
      const s = await this.bridge.request("care.locate", {
        operationId,
        revision: this.revision,
      });
      if (this.active) {
        this.accept(s);
        this.notice.textContent = "大致位置已刷新。";
      }
    } catch (e) {
      if (this.active) this.notice.textContent = error(e);
    } finally {
      if (this.locating === operationId) this.locating = undefined;
      this.controls();
      if (this.active) void this.refresh();
    }
  }
  private async cancelLocation() {
    if (!this.locating) return;
    try {
      await this.bridge.request("care.locate.cancel", {
        operationId: this.locating,
      });
    } catch (e) {
      if (this.active) this.notice.textContent = error(e);
    }
  }
}
