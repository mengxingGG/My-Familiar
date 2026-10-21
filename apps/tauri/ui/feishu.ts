import type { MobileBridge, MobileFeishuStatus } from "../../../packages/mobile-contracts/index.ts";
import { FeishuAuthView } from "./feishu-auth.ts";
type Confirm = { title: string; body: string; confirmLabel: string; action: () => Promise<unknown>; done: string; tone?: "danger" | "primary" };
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };
const button = (text: string, action: () => void, className = "quiet") => { const b = node("button", text, className); b.type = "button"; b.addEventListener("click", action); return b; };
const field = (text: string, input: HTMLElement) => {
  const check = input instanceof HTMLInputElement && input.type === "checkbox";
  const label = node("label", "", check ? "voice-check" : "field"); input.setAttribute("aria-label", text);
  if (check) label.append(input, document.createTextNode(text)); else label.append(node("span", text, "field-label"), input);
  return label;
};
const reason = (error: unknown) => ({ CONFLICT: "配置已变化。草稿已保留，请重新读取后核对。", INVALID_INPUT: "请检查应用编号和密钥；开启前需要保存密钥。", LIMIT: "最多配对 20 个用户，请先移除不用的配对。", UNAVAILABLE: "连接尚未就绪，请检查状态后重试。" })[(error as { code?: string })?.code ?? ""] ?? "操作未确认，请刷新状态后核对。";

/** 只保留表单草稿；配对、连接与回复由共享核心持有。 */
export class FeishuView {
  readonly page = node("section", "", "page feishu-page");
  readonly heading = node("h1", "飞书");
  private form = node("form", "", "panel panel-form");
  private appId = node("input");
  private secret = node("input");
  private enabled = node("input");
  private clear = node("input");
  private keyHint = node("p", "", "block-hint");
  private state = node("p", "", "block-hint");
  private notice = node("p", "", "form-status");
  private pairing = node("p", "", "feishu-pair-code");
  private users = node("div", "", "feishu-users");
  private officeEnabled = node("input");
  private officeIdentity = node("select");
  private auth: FeishuAuthView;
  private officeState = node("p", "", "block-hint");
  private officeSave: HTMLButtonElement;
  private officeCheck: HTMLButtonElement;
  private officePanel = node("section", "", "panel panel-form");
  private officeDirty = false;
  private officeRevision = "";
  private officeChannelRevision = "";
  private save: HTMLButtonElement;
  private stop: HTMLButtonElement;
  private pair: HTMLButtonElement;
  private reload: HTMLButtonElement;
  private value?: MobileFeishuStatus;
  private revision = "";
  private dirty = false;
  private pending = false;
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private readSequence = 0;
  constructor(private bridge: MobileBridge, back: HTMLButtonElement, private confirm: (spec: Confirm) => void) {
    this.page.hidden = true; this.heading.tabIndex = -1; this.heading.id = "feishu-heading"; this.page.setAttribute("aria-labelledby", this.heading.id);
    const bar = node("header", "", "pagebar"); bar.append(back, this.heading);
    const body = node("div", "", "page-body feishu-body"); this.page.append(bar, body);
    this.appId.type = "text"; this.appId.placeholder = "cli_ 后接 16 位编号"; this.appId.maxLength = 20; this.appId.autocomplete = "off";
    this.secret.type = "password"; this.secret.maxLength = 500; this.secret.autocomplete = "new-password";
    this.enabled.type = this.clear.type = "checkbox";
    this.state.setAttribute("role", "status"); this.notice.setAttribute("role", "status");
    this.save = button("保存并应用", () => { void this.persist(); }, "primary");
    this.stop = button("停止私聊", () => { void this.perform(async () => { const status = await this.bridge.request("feishu.stop", undefined); this.enabled.checked = false; this.revision = status.revision; this.receive(status, false); this.notice.textContent = "私聊已停止，未发送的回复已取消。"; }); });
    this.pair = button("生成配对码", () => { void this.perform(async () => this.receive(await this.bridge.request("feishu.pair", { revision: this.revision }), false)); });
    this.reload = button("重新读取", () => {
      const action = async () => { await this.mutate(async () => this.receive(await this.bridge.request("feishu.status", undefined), true)); };
      if (this.dirty || this.officeDirty) this.confirm({ title: "重新读取飞书设置？", body: "这会丢弃当前未保存的修改和密钥输入。", confirmLabel: "重新读取", action, done: "已重新读取。" });
      else void action().catch(error => { this.notice.textContent = reason(error); });
    });
    const buttons = node("div", "", "feishu-actions"); buttons.append(this.save, this.reload, this.stop);
    this.form.append(field("应用编号（App ID）", this.appId), field("应用密钥（留空保留）", this.secret), this.keyHint,
      field("开启飞书私聊", this.enabled), field("清除已保存的应用密钥", this.clear), buttons, this.notice);
    this.form.addEventListener("submit", e => { e.preventDefault(); void this.persist(); });
    this.form.addEventListener("input", () => { this.dirty = true; if (this.clear.checked) this.enabled.checked = false; this.update(); });
    this.officeEnabled.type = "checkbox";
    this.officeEnabled.addEventListener("change", () => { this.officeDirty = true; this.update(); });
    this.officeState.setAttribute("role", "status");
    this.officeSave = button("保存办公设置", () => { void this.perform(async () => {
      const value = await this.bridge.request("feishu.office.save", { enabled: this.officeEnabled.checked, identity: this.officeIdentity.value as "bot" | "user", revision: this.officeRevision, channelRevision: this.officeChannelRevision });
      this.officeDirty = false; this.receive(value, false); this.notice.textContent = "办公设置已保存。";
    }); }, "primary");
    this.officeCheck = button("检查办公组件", () => { void this.perform(async () => this.receive(await this.bridge.request("feishu.office.check", undefined), false)); });
    const officeActions = node("div", "", "feishu-actions"); officeActions.append(this.officeSave, this.officeCheck);
    for (const [value, label] of [["bot", "机器人"], ["user", "个人账号"]]) { const option = node("option", label); option.value = value; this.officeIdentity.append(option); }
    this.officeIdentity.addEventListener("change", () => { this.officeDirty = true; this.update(); });
    this.auth = new FeishuAuthView(bridge, value => this.receive(value, false), action => this.perform(action), confirm, action => this.mutate(action));
    this.officePanel.append(node("h2", "办公能力", "block-title"), field("办公身份", this.officeIdentity), field("开启办公能力", this.officeEnabled),
      node("p", "使用上方已保存的应用身份访问获准的文档、日程和任务等。与私聊开关独立；开启后直接在对话中提出需求。外部写入按工具权限设置批准。", "block-hint"),
      node("p", "选择个人账号前请完成下方登录。检查组件只验证手机内置程序，不连接飞书。", "block-hint"), this.officeState, officeActions);
    body.append(node("p", "连接飞书自建应用，在飞书里联系灵伴，或让灵伴处理应用获准的办公内容。", "block-hint"), this.form, this.officePanel, this.auth.panel,
      node("h2", "连接与配对", "block-title"), this.state, this.pair, this.pairing, this.users,
      node("p", "先在飞书开放平台为自建应用开启机器人、私聊消息接收和机器人回复权限，并订阅 im.message.receive_v1，选择长连接。开启常驻伙伴并连接后，给机器人私聊发送配对码。", "block-hint"),
      node("p", "配对码有效期 10 分钟、仅用一次。未配对用户和群聊不会进入模型。发送 /new 开始新的私聊上下文，记忆保留。停止常驻期间暂停连接；系统休眠或断网可能延迟收信。", "block-hint"));
    this.update();
  }
  open() { this.active = true; this.generation++; void this.refresh(false); }
  close() { this.active = false; this.generation++; clearTimeout(this.timer); }
  dispose() { this.close(); this.secret.value = ""; }
  private receive(value: MobileFeishuStatus, force: boolean) {
    this.value = value;
    if (force || !this.dirty) { this.appId.value = value.appId; this.enabled.checked = value.enabled; this.secret.value = ""; this.clear.checked = false; this.revision = value.revision; this.dirty = false; }
    if (force || !this.officeDirty) { this.officeEnabled.checked = value.office?.enabled ?? false; this.officeIdentity.value = value.office?.identity ?? "bot"; this.officeRevision = value.office?.revision ?? ""; this.officeChannelRevision = value.revision; this.officeDirty = false; }
    this.update();
  }
  private async refresh(force: boolean) {
    if (this.pending) return;
    clearTimeout(this.timer); const generation = this.generation, sequence = ++this.readSequence;
    const current = () => this.active && generation === this.generation && sequence === this.readSequence;
    try { const value = await this.bridge.request("feishu.status", undefined); if (current()) this.receive(value, force); }
    catch (error) { if (current()) this.notice.textContent = reason(error); }
    finally { if (current()) this.timer = setTimeout(() => { void this.refresh(false); }, 1500); }
  }
  private async mutate(action: () => Promise<unknown>) {
    if (this.pending) throw Error("操作正在进行中");
    this.readSequence++; clearTimeout(this.timer); this.pending = true; this.update();
    try { await action(); }
    finally { this.pending = false; this.update(); if (this.active) this.timer = setTimeout(() => { void this.refresh(false); }, 1500); }
  }
  private async perform(action: () => Promise<unknown>) {
    if (this.pending) return;
    try { await this.mutate(action); } catch (error) { this.notice.textContent = reason(error); }
  }
  private async persist() {
    if (!this.value) return;
    await this.perform(async () => {
      const status = await this.bridge.request("feishu.save", { revision: this.revision, appId: this.appId.value.trim(), enabled: this.enabled.checked,
        allowedUsers: this.value!.allowedUsers, ...(this.secret.value ? { appSecret: this.secret.value } : {}), ...(this.clear.checked ? { clearSecret: true } : {}) });
      this.receive(status, true); this.notice.textContent = "设置已保存。";
    });
  }
  private update() {
    const s = this.value;
    this.auth?.update(s, this.pending, this.dirty);
    this.officePanel.hidden = !s?.office;
    this.officeEnabled.disabled = this.pending || !s?.office?.available;
    this.officeIdentity.disabled = this.pending || !s?.office?.available;
    this.officeSave.disabled = this.pending || this.dirty || !s?.office?.available;
    this.officeCheck.disabled = this.pending || !s?.office?.available || !!s?.office?.checking || !!s?.office?.pending;
    this.officeState.textContent = s?.office ? s.office.detail + (s.office.pending ? ` 正在处理 ${s.office.pending} 项。` : "") : "";
    this.save.disabled = this.pending || !s; this.reload.disabled = this.pending;
    this.stop.disabled = this.pending || !s?.enabled;
    this.pair.disabled = this.pending || this.dirty || s?.phase !== "connected";
    for (const input of [this.appId, this.secret, this.enabled, this.clear]) input.disabled = this.pending;
    this.state.textContent = s ? s.detail + (s.pending ? ` 待处理 ${s.pending} 条。` : "") : "正在读取状态…";
    this.keyHint.textContent = s?.hasSecret ? "已加密保存，密钥不会回填。更换应用编号会清除原密钥和配对。" : "尚未保存密钥。保存但不开启时不会连接飞书。";
    this.pairing.textContent = s?.pairing && s.pairing.expires > Date.now() ? `/pair ${s.pairing.code}\n请在飞书中私聊发给机器人。` : "";
    this.users.replaceChildren(node("h2", `已配对用户 · ${s?.allowedUsers.length ?? 0}`, "block-title"));
    for (const id of s?.allowedUsers ?? []) {
      const row = node("div", "", "feishu-user"); row.append(node("code", id));
      const remove = button("移除配对", () => this.confirm({ title: "移除这个配对？", body: `${id}\n之后该用户的私聊不会交给模型。`, confirmLabel: "移除配对", action: () => this.mutate(async () => {
        const current = this.value!; const updated = await this.bridge.request("feishu.save", { appId: current.appId, enabled: current.enabled, allowedUsers: current.allowedUsers.filter(user => user !== id), revision: current.revision });
        this.receive(updated, true);
      }), done: "已移除配对。" }));
      remove.disabled = this.pending || this.dirty; row.append(remove); this.users.append(row);
    }
  }
}
