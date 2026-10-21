import type {
  MobileBridge,
  ToolPolicy,
} from "../../../packages/mobile-contracts/index.ts";
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
const button = (text: string, click: () => void, cls = "quiet") => {
  const n = el("button", text, cls);
  n.type = "button";
  n.onclick = click;
  return n;
};
const modes = [
  ["auto", "全自动", "所有工具直接执行；Android 系统权限仍需你授权。"],
  [
    "limited",
    "有限执行",
    "读取和灵伴工作区内写入直接执行；手机操作、日历写入和外部工具等按规则确认。",
  ],
  [
    "approval",
    "审批制度",
    "操作先确认；你添加的精确白名单与本会话授权可直接执行。",
  ],
  ["deny", "全部拒绝", "拒绝其余工具，包括已添加的白名单和会话授权。"],
] as const;

export class PermissionsView {
  readonly page = el("section", "", "page permissions-page");
  readonly heading = el("h1", "权限管理");
  private body = el("div", "", "page-body");
  private notice = el("p", "", "form-status");
  private select = el("select");
  private detail = el("p", "", "block-hint");
  private rules = el("div", "", "panel rows");
  private state?: ToolPolicy;
  private active = false;
  private generation = 0;
  private busy = false;
  constructor(
    private bridge: MobileBridge,
    back: HTMLButtonElement,
  ) {
    this.page.hidden = true;
    this.heading.tabIndex = -1;
    this.heading.id = "permissions-heading";
    this.page.setAttribute("aria-labelledby", this.heading.id);
    for (const [value, text] of modes) {
      const o = el("option", text);
      o.value = value;
      this.select.append(o);
    }
    this.select.setAttribute("aria-label", "全局权限模式");
    this.select.onchange = () => this.description();
    const label = el("label", "全局权限模式", "field");
    label.append(this.select);
    const form = el("div", "", "panel panel-form");
    form.append(
      label,
      this.detail,
      el(
        "p",
        "联网搜索、内部日记和记忆始终放行，所有模式均如此。更改模式会撤销本会话授权并结束尚未批准的操作。",
        "block-hint",
      ),
      button(
        "保存权限设置",
        () =>
          void this.run(async () => {
            if (this.state)
              this.receive(
                await bridge.request("policy.set", {
                  ...this.state,
                  mode: this.select.value as ToolPolicy["mode"],
                }),
              );
          }),
        "primary",
      ),
    );
    const head = el("header", "", "pagebar");
    head.append(back, this.heading);
    this.body.append(
      form,
      this.notice,
      el("h2", "已添加的白名单", "block-title"),
      el(
        "p",
        "白名单匹配具体目标或操作参数；审批卡也可只允许一次，或允许当前会话的全部工具。换会话、重启和撤销后，会话授权失效。",
        "block-hint",
      ),
      this.rules,
      button(
        "撤销本会话全部授权",
        () =>
          void this.run(async () => {
            await bridge.request("policy.resetSession", undefined);
          }),
      ),
      button("重新读取", () => void this.load()),
    );
    this.page.append(head, this.body);
  }
  open() {
    this.active = true;
    void this.load();
  }
  close() {
    this.active = false;
    this.generation++;
  }
  private description() {
    this.detail.textContent =
      modes.find((m) => m[0] === this.select.value)?.[2] ?? "";
  }
  private async load() {
    const gen = ++this.generation;
    await this.run(async () => {
      const p = await this.bridge.request("policy.get", undefined);
      if (this.active && gen === this.generation) this.receive(p);
    });
  }
  private receive(p: ToolPolicy) {
    this.state = p;
    this.select.value = p.mode;
    this.description();
    this.rules.replaceChildren();
    for (const r of p.whitelist) {
      const row = el("div", "", "row-setting"),
        text = el("small", r.label, "row-text");
      row.append(
        text,
        button(
          "撤销",
          () =>
            void this.run(async () => {
              const latest = await this.bridge.request("policy.get", undefined);
              this.receive(
                await this.bridge.request("policy.set", {
                  ...latest,
                  whitelist: latest.whitelist.filter((v) => v.key !== r.key),
                }),
              );
            }),
        ),
      );
      this.rules.append(row);
    }
    if (!p.whitelist.length)
      this.rules.append(
        el("p", "还没有白名单。审批时选择“添加白名单”即可保存。", "block-hint"),
      );
  }
  private async run(fn: () => Promise<void>) {
    if (this.busy || !this.active) return;
    this.busy = true;
    this.notice.textContent = "正在处理…";
    this.body
      .querySelectorAll("button,select")
      .forEach((n) => ((n as HTMLButtonElement).disabled = true));
    try {
      await fn();
      if (this.active) this.notice.textContent = "已完成。";
    } catch {
      if (this.active) this.notice.textContent = "未能完成，请重新读取并核对。";
    } finally {
      this.busy = false;
      this.body
        .querySelectorAll("button,select")
        .forEach((n) => ((n as HTMLButtonElement).disabled = false));
    }
  }
}
