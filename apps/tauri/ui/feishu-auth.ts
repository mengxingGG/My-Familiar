import type { MobileBridge, MobileFeishuStatus } from "../../../packages/mobile-contracts/index.ts";
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };
const button = (text: string, action: () => void) => { const n = node("button", text, "quiet"); n.type = "button"; n.addEventListener("click", action); return n; };
type Confirm = (value: { title: string; body: string; confirmLabel: string; action: () => Promise<unknown>; done: string }) => void;
/** 页面只展示官方授权地址对应的状态，设备码和令牌留在核心。 */
export class FeishuAuthView {
  readonly panel = node("section", "", "panel panel-form feishu-auth");
  private state = node("p", "", "block-hint");
  private code = node("p", "", "feishu-auth-code");
  private missing = node("p", "", "block-hint");
  private scopes = node("textarea");
  private start: HTMLButtonElement;
  private open: HTMLButtonElement;
  private cancel: HTMLButtonElement;
  private forget: HTMLButtonElement;
  private supplement: HTMLButtonElement;
  private custom: HTMLButtonElement;
  private value?: MobileFeishuStatus;
  constructor(private bridge: MobileBridge, private receive: (value: MobileFeishuStatus) => void, private perform: (action: () => Promise<unknown>) => Promise<unknown>, confirm: Confirm, mutate: (action: () => Promise<unknown>) => Promise<unknown>) {
    const actions = node("div", "", "feishu-actions");
    const begin = (scopes: string[]) => this.perform(async () => { const s = this.value!; this.receive(await bridge.request("feishu.auth.begin", { revision: s.auth!.revision, channelRevision: s.revision, scopes })); });
    const action = (method: "feishu.auth.open" | "feishu.auth.cancel" | "feishu.auth.forget") => this.perform(async () => this.receive(await bridge.request(method, { revision: this.value!.auth!.revision })));
    this.start = button("登录个人账号", () => { void begin([]); });
    this.open = button("打开飞书授权页", () => { void action("feishu.auth.open"); });
    this.cancel = button("取消本次登录", () => { void action("feishu.auth.cancel"); });
    this.forget = button("清除本机登录", () => { const revision = this.value!.auth!.revision; confirm({ title: "清除本机个人登录？", body: "个人身份的办公任务会停止。飞书中的应用授权需要在飞书中另行撤销。", confirmLabel: "清除本机登录", action: () => mutate(async () => this.receive(await bridge.request("feishu.auth.forget", { revision }))), done: "本机个人登录已清除。" }); });
    this.supplement = button("补充以上权限", () => { void begin([...(this.value?.office?.missingScopes ?? [])]); });
    this.scopes.rows = 3; this.scopes.maxLength = 3000; this.scopes.placeholder = "例如 calendar:calendar:read，多个权限用空格分隔"; this.scopes.setAttribute("aria-label", "需要申请的飞书权限");
    this.custom = button("申请填写的权限", () => { const scopes = this.scopes.value.trim().split(/[\s,，]+/).filter(Boolean); if (scopes.length) void begin(scopes); });
    const advanced = node("details"); advanced.append(node("summary", "指定权限"), node("p", "按实际需要填写应用已开通的权限。授权页面会列出申请内容，由你确认。", "block-hint"), this.scopes, this.custom);
    this.state.setAttribute("role", "status"); actions.append(this.start, this.open, this.cancel, this.forget);
    this.panel.append(node("h2", "个人账号", "block-title"), this.state, this.code, actions, this.missing, this.supplement, advanced,
      node("p", "使用上方已保存的应用发起登录，在飞书官方页面确认后返回。登录后可将办公身份切换为个人账号；凭据只加密保存在本机。", "block-hint"));
  }
  update(value: MobileFeishuStatus | undefined, pending: boolean, dirty: boolean) {
    this.value = value; const a = value?.auth, authorizing = a?.phase === "authorizing", unavailable = pending || dirty || !a || !value?.hasSecret || !value?.appId || a.phase === "refreshing";
    this.panel.hidden = !a;
    this.state.textContent = (a?.user ? `${a.user.name} · ${a.user.id}\n` : "") + (a?.detail ?? "");
    this.start.textContent = a?.connected ? "重新登录个人账号" : "登录个人账号";
    this.start.disabled = unavailable || authorizing; this.custom.disabled = unavailable || authorizing; this.scopes.disabled = unavailable || authorizing;
    this.open.hidden = !a?.authorization; this.open.disabled = pending || dirty || !a?.authorization || a.authorization.expiresAt <= Date.now();
    this.cancel.hidden = !authorizing; this.cancel.disabled = pending;
    this.forget.hidden = !a?.user && !a?.connected && a?.phase !== "error"; this.forget.disabled = pending;
    this.code.textContent = a?.authorization ? `授权码：${a.authorization.userCode}\n剩余 ${Math.max(0, Math.ceil((a.authorization.expiresAt - Date.now()) / 1000))} 秒` : "";
    const missing = value?.office?.missingScopes ?? [];
    this.missing.textContent = missing.length ? "上次操作需要以下权限：\n" + missing.join("\n") : "";
    this.supplement.hidden = !missing.length; this.supplement.disabled = unavailable || authorizing;
  }
}
