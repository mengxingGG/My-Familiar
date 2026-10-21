import type {
  MobileBridge,
  MobileMcpConfig,
  MobileMcpServer,
} from "../../../packages/mobile-contracts/index.ts";
import { githubConfig, isGithubConfig } from "../../../plugins/github-integration/config.ts";
import { GithubAuthPanel } from './github-auth.ts';
type Confirm = {
  title: string;
  body: string;
  confirmLabel: string;
  action: () => Promise<unknown>;
  done: string;
  tone?: "danger" | "primary";
};
type Draft = {
  config: MobileMcpConfig;
  revision: string | null;
  key: string;
  clearKey: boolean;
  dirty: boolean;
  edits: number;
};
const node = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
) => {
  const n = document.createElement(tag);
  n.textContent = text;
  n.className = className;
  return n;
};
const button = (text: string, act: () => void, cls = "quiet") => {
  const b = node("button", text, cls);
  b.type = "button";
  b.addEventListener("click", act);
  return b;
};
const label = (text: string, input: HTMLElement) => {
  const l = node("label", "", "field");
  if (!input.hasAttribute("aria-label")) input.setAttribute("aria-label", text);
  l.append(node("span", text, "field-label"), input);
  return l;
};
const reason = (e: unknown) =>
  ({
    CONFLICT: "配置已变化。草稿已保留，请重新读取后核对。",
    CANCELLED: "连接已取消。",
    PROVIDER: "连接失败，请检查服务地址、鉴权和网络。",
    INVALID_INPUT: "请检查名称、HTTPS 地址和鉴权字段。",
    BUSY: "连接仍在处理中，请稍后再试。",
    NOT_FOUND: "服务已被移除，请刷新列表。",
  })[(e as { code?: string })?.code ?? ""] ??
  "操作状态未确认，请刷新并核对后再试。";
const from = (s: MobileMcpServer): Draft => ({
  config: {
    id: s.id,
    name: s.name,
    transport: "http",
    url: s.url,
    enabled: s.enabled,
    ...(s.auth ? { auth: { ...s.auth } } : {}),
  },
  revision: s.revision,
  key: "",
  clearKey: false,
  dirty: false,
  edits: 0,
});

/** UI 只保留编辑草稿；网络、凭据和工具注册由共享 MCP 服务持有。 */
export class McpView {
  readonly page = node("section", "", "page mcp-page");
  readonly heading = node("h1", "网络工具 · MCP");
  private readonly body = node("div", "", "page-body mcp-body");
  private readonly select = node("select");
  private readonly notice = node("p", "", "form-status");
  private readonly status = node("p", "", "block-hint");
  private readonly form = node("form", "", "panel panel-form");
  private readonly name = node("input");
  private readonly url = node("input");
  private readonly enabled = node("input");
  private readonly auth = node("select");
  private readonly authName = node("input");
  private readonly prefix = node("input");
  private readonly key = node("input");
  private readonly clearKey = node("input");
  private readonly keyHint = node("p", "", "block-hint");
  private readonly tools = node("pre", "", "library-source mcp-tools");
  private readonly save: HTMLButtonElement;
  private readonly connect: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly disconnect: HTMLButtonElement;
  private readonly remove: HTMLButtonElement;
  private readonly add: HTMLButtonElement;
  private readonly reload: HTMLButtonElement;
  private readonly github: HTMLButtonElement;
  private readonly githubReadOnly = node("input");
  private readonly githubOptions = node("div", "", "github-options");
  private readonly githubIntro = node('p','','block-hint');
  private readonly githubLogin: GithubAuthPanel;
  private githubAuthSupported = false;
  private authBusy = false;
  private rows: MobileMcpServer[] = [];
  private drafts = new Map<string, Draft>();
  private selected = "";
  private active = false;
  private listVersion = 0;
  private pending = false;
  private connecting?: { id: string; operationId: string };
  constructor(
    private bridge: MobileBridge,
    back: HTMLButtonElement,
    private confirm: (s: Confirm) => void,
  ) {
    this.githubLogin = new GithubAuthPanel(bridge,confirm,async status=>{
      const d=this.current();if(!d||!isGithubConfig(d.config))throw {code:'CONFLICT'};if(d.key||d.clearKey)throw {code:'TOKEN_DRAFT'};
      const result=await this.bridge.request('github.auth.apply',{revision:status.revision,targetRevision:status.targetRevision,readOnly:this.githubReadOnly.checked,enabled:this.enabled.checked});
      this.drafts.delete('github');await this.refresh();return result;
    },busy=>{this.authBusy=busy;this.updateControls();},()=>{void this.refresh();});
    this.page.hidden = true;
    this.heading.tabIndex = -1;
    this.heading.id = "mcp-heading";
    this.page.setAttribute("aria-labelledby", this.heading.id);
    const bar = node("header", "", "pagebar");
    bar.append(back, this.heading);
    this.page.append(bar, this.body);
    this.select.setAttribute("aria-label", "MCP 服务");
    this.select.addEventListener("change", () => {
      this.selected = this.select.value;
      this.notice.textContent = "";
      this.renderForm();
    });
    this.add = button("添加服务", () => {
      const id = "mcp-" + crypto.randomUUID().slice(0, 24);
      this.selected = id;
      this.drafts.set(id, {
        config: {
          id,
          name: "",
          transport: "http",
          url: "https://",
          enabled: false,
        },
        revision: null,
        key: "",
        clearKey: false,
        dirty: true,
        edits: 0,
      });
      this.notice.textContent = "";
      this.renderList();
      this.renderForm();
      this.name.focus();
    });
    this.reload = button("重新读取", () => this.reloadCurrent());
    this.github = button("GitHub 官方", () => this.openGithub());
    const controls = node("div", "", "mcp-actions");
    controls.append(this.github, this.add, this.reload);
    this.body.append(
      node(
        "p",
        "把搜索、地图或其他服务提供的工具接入聊天。支持 HTTP MCP；每个服务的工具权限沿用灵伴审批。",
        "block-hint",
      ),
      label("服务", this.select),
      controls,
      this.notice,
      this.form,
    );
    this.name.type = this.authName.type = this.prefix.type = "text";
    this.name.maxLength = 100;
    this.name.required = true;
    this.url.type = "url";
    this.url.maxLength = 2000;
    this.url.required = true;
    this.url.spellcheck = false;
    this.enabled.type = "checkbox";
    const enableLabel = node("label", "", "voice-check");
    enableLabel.append(
      this.enabled,
      document.createTextNode("启用服务，应用启动时自动连接"),
    );
    for (const [v, t] of [
      ["none", "无需密钥"],
      ["header", "请求头鉴权"],
      ["query", "查询参数鉴权"],
    ]) {
      const o = node("option", t);
      o.value = v;
      this.auth.append(o);
    }
    this.authName.maxLength = 100;
    this.authName.required = true;
    this.prefix.maxLength = 100;
    this.key.type = "password";
    this.key.autocomplete = "new-password";
    this.key.maxLength = 8000;
    this.clearKey.type = "checkbox";
    this.githubReadOnly.type = "checkbox";
    this.githubReadOnly.setAttribute("aria-label", "GitHub 只读模式");
    const readOnlyLabel = node("label", "", "voice-check");
    readOnlyLabel.append(this.githubReadOnly, document.createTextNode("只读模式"));
    this.githubOptions.append(node("h2", "GitHub 官方", "block-title"),
      this.githubIntro, readOnlyLabel,
      node("p", "关闭只读后，修改操作仍需逐项确认。", "block-hint"),
      node("p", "切换只读模式会断开旧连接，保留已保存的凭据；重新连接后生效。清除凭据同时停用服务。", "block-hint"),this.githubLogin.node);
    this.githubReadOnly.addEventListener("input", () => {
      this.url.value = githubConfig(this.githubReadOnly.checked).url!;
      this.edit();
    });
    const clearLabel = node("label", "", "voice-check");
    clearLabel.append(
      this.clearKey,
      document.createTextNode("清除此地址已保存的密钥"),
    );
    this.save = button("保存设置", () => {}, "primary");
    this.save.type = "submit";
    this.connect = button(
      "连接并读取工具",
      () => void this.connectNow(),
      "primary",
    );
    this.cancel = button("取消连接", () => void this.cancelConnect());
    this.disconnect = button("断开本次连接", () => void this.disconnectNow());
    this.remove = button("移除服务", () => this.removeCurrent(), "quiet danger");
    const actions = node("div", "", "mcp-actions");
    actions.append(
      this.save,
      this.connect,
      this.cancel,
      this.disconnect,
      this.remove,
    );
    this.form.append(
      label("服务名称", this.name),
      this.githubOptions,
      label("MCP 服务地址", this.url),
      enableLabel,
      node(
        "p",
        "保存后可手动连接；停用并保存会断开服务。地址或鉴权变化后，需要为新连接重新保存密钥。",
        "block-hint",
      ),
      label("鉴权方式", this.auth),
      label("鉴权字段名", this.authName),
      label("密钥前缀（可留空）", this.prefix),
      label("密钥（留空保留）", this.key),
      this.keyHint,
      clearLabel,
      actions,
      this.status,
      node("h2", "已连接的工具", "block-title"),
      this.tools,
    );
    this.notice.setAttribute("role", "status");
    this.status.setAttribute("role", "status");
    this.form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.saveNow();
    });
    for (const input of [
      this.name,
      this.url,
      this.enabled,
      this.auth,
      this.authName,
      this.prefix,
      this.key,
      this.clearKey,
    ])
      input.addEventListener("input", () => this.edit());
  }
  open() {
    this.active = true;
    void this.refresh();
  }
  close() {
    this.githubLogin.close();
    this.active = false;
    this.listVersion++;
    void this.cancelConnect();
    for (const d of this.drafts.values()) d.key = "";
    this.key.value = "";
  }
  dispose() {
    this.close();
  }
  supportGithubAuth(value:boolean){this.githubAuthSupported=value;this.updateControls();}
  private current() {
    return this.drafts.get(this.selected);
  }
  private openGithub() {
    if (this.pending || this.connecting) return;
    const existing = this.drafts.get("github"), row = this.rows.find(s => s.id === "github");
    if ((existing && !isGithubConfig(existing.config)) || (row && !isGithubConfig(row))) {
      this.notice.textContent = "已有名为 github 的服务使用其他地址或鉴权，请先核对该服务。";
      return;
    }
    this.selected = "github";
    if (!existing) this.drafts.set("github", row ? from(row) : {
      config: githubConfig(true) as MobileMcpConfig, revision: null,
      key: "", clearKey: false, dirty: true, edits: 0,
    });
    this.notice.textContent = "";this.renderList();this.renderForm();this.key.focus();
  }
  private async refresh() {
    const ticket = ++this.listVersion;
    try {
      const rows = await this.bridge.request("mcp.list", undefined);
      if (ticket !== this.listVersion || !this.active) return;
      this.rows = rows;
      for (const s of rows)
        if (!this.drafts.get(s.id)?.dirty) this.drafts.set(s.id, from(s));
      if (!this.selected || !rows.some(s=>s.id===this.selected) && !this.drafts.has(this.selected)) this.selected = rows[0]?.id ?? "";
      this.renderList();
      this.renderForm();
    } catch (e) {
      if (ticket === this.listVersion && this.active)
        this.notice.textContent = reason(e);
    }
  }
  private renderList() {
    this.select.replaceChildren();
    for (const s of this.rows) {
      const o = node("option", s.name || s.id);
      o.value = s.id;
      this.select.append(o);
    }
    for (const [id, d] of this.drafts)
      if (d.revision === null) {
        const o = node("option", d.config.name || "新服务");
        o.value = id;
        this.select.append(o);
      }
    this.select.value = this.selected;
  }
  private renderForm() {
    const d = this.current();
    this.form.hidden = !d;
    if (!d) {
      this.updateControls();
      return;
    }
    this.name.value = d.config.name;
    this.url.value = d.config.url;
    this.enabled.checked = d.config.enabled;
    this.auth.value = d.config.auth?.kind ?? "none";
    this.authName.value = d.config.auth?.name ?? "";
    this.prefix.value = d.config.auth?.prefix ?? "";
    this.key.value = d.key;
    this.clearKey.checked = d.clearKey;
    this.githubReadOnly.checked = d.config.url.endsWith("/readonly");
    this.updateControls();
  }
  private edit() {
    const d = this.current();
    if (!d) return;
    d.config = {
      ...d.config,
      name: this.name.value,
      url: this.url.value,
      enabled: this.enabled.checked,
      auth:
        this.auth.value === "none"
          ? undefined
          : {
              kind: this.auth.value as "header" | "query",
              name: this.authName.value,
              prefix: this.prefix.value,
            },
    };
    if (this.auth.value === 'none') this.key.value = '';
    d.key = this.key.value;
    d.clearKey = this.clearKey.checked;
    d.dirty = true;
    d.edits++;
    this.notice.textContent = "有未保存的修改。";
    this.updateControls();
  }
  private updateControls() {
    const d = this.current(),
      row = this.rows.find((s) => s.id === this.selected),
      locked = this.pending || !!this.connecting || this.authBusy;
    this.select.disabled = locked;
    this.add.disabled = locked;
    this.github.disabled = locked;
    this.reload.disabled = locked;
    this.save.disabled = locked;
    this.connect.disabled =
      locked || !d || d.dirty || !d.config.enabled || !d.revision;
    this.disconnect.disabled = locked || !row?.connected;
    this.remove.disabled = locked || !d?.revision;
    this.cancel.hidden = !this.connecting;
    this.authName.disabled =
      this.prefix.disabled =
      this.key.disabled =
        this.auth.value === "none" || this.authBusy;
    this.clearKey.disabled = !row?.hasKey || locked;
    const github = !!d && isGithubConfig(d.config);
    this.githubIntro.textContent=this.githubAuthSupported?'使用浏览器授权或 GitHub Token 连接仓库、Issue 和 PR，可用工具取决于账号权限。':'使用 GitHub Token 连接仓库、Issue 和 PR，可用工具取决于 Token 权限。';
    this.githubLogin.show(this.active&&this.githubAuthSupported&&github,this.pending||!!this.connecting);
    this.githubOptions.hidden = !github;
    this.githubReadOnly.disabled = locked;
    for (const field of [this.name, this.url, this.auth, this.authName, this.prefix]) field.closest("label")!.hidden = github;
    this.key.required = github && this.enabled.checked && !this.clearKey.checked && !row?.hasKey;
    this.key.setAttribute("aria-label", github ? "GitHub Token（留空保留）" : "密钥（留空保留）");
    this.key.closest("label")!.querySelector(".field-label")!.textContent = github ? "GitHub Token（留空保留）" : "密钥（留空保留）";
    this.status.textContent = this.connecting
      ? "正在连接并读取工具…"
      : row?.connected
        ? `已连接 · ${row.tools} 个工具`
        : (row?.error ?? "尚未连接。");
    this.tools.textContent = row?.connected
      ? row.toolNames.join("\n") || "服务未提供可调用工具。"
      : "连接后显示工具名称。";
    const same =
      d &&
      row &&
      d.config.url.trim() === row.url &&
      JSON.stringify(d.config.auth) === JSON.stringify(row.auth);
    this.keyHint.textContent =
      ((same || github) && row?.hasKey
        ? "此地址已保存密钥，留空保留。"
        : d?.dirty
          ? "配置已修改，保存后确认密钥状态。"
          : "此地址没有已保存密钥。") + " 未保存的密钥离开此页后清空。";
  }
  private async saveNow() {
    const d = this.current();
    if (!d || this.pending || this.connecting || this.authBusy || !this.form.reportValidity())
      return;
    const params = {
      config: structuredClone(d.config),
      revision: d.revision,
      ...(d.key ? { apiKey: d.key } : {}),
      clearApiKey: d.clearKey,
    };
    const edits = d.edits;
    this.pending = true;
    this.listVersion++;
    this.updateControls();
    try {
      const saved = isGithubConfig(params.config)
        ? await this.bridge.request("mcp.github.save", {
          enabled: params.config.enabled, readOnly: params.config.url.endsWith("/readonly"),
          revision: params.revision, ...(params.apiKey ? { apiKey: params.apiKey } : {}), clearApiKey: params.clearApiKey,
        })
        : await this.bridge.request("mcp.save", params);
      this.listVersion++;
      this.rows = [...this.rows.filter((s) => s.id !== saved.id), saved];
      if (d.edits === edits) this.drafts.set(saved.id, from(saved));
      else {
        d.revision = saved.revision;
        if (d.key === params.apiKey) d.key = "";
      }
      if (this.active) {
        this.notice.textContent =
          d.edits === edits
            ? "设置已保存。"
            : "设置已保存，之后的编辑尚未保存。";
        this.renderList();
        this.renderForm();
      }
    } catch (e) {
      if (this.active) this.notice.textContent = reason(e);
    } finally {
      this.pending = false;
      if (this.active) this.updateControls();
    }
  }
  private async connectNow() {
    const d = this.current();
    if (!d?.revision || d.dirty || this.pending || this.connecting) return;
    const operationId = crypto.randomUUID();
    this.connecting = { id: d.config.id, operationId };
    this.notice.textContent = "";
    this.updateControls();
    try {
      await this.bridge.request("mcp.connect", {
        id: d.config.id,
        revision: d.revision,
        operationId,
      });
      if (this.active)
        this.notice.textContent = "连接已建立，工具现在可用于聊天。";
    } catch (e) {
      if (this.active) this.notice.textContent = reason(e);
    } finally {
      if (this.connecting?.operationId === operationId)
        this.connecting = undefined;
      if (this.active) {
        this.updateControls();
        await this.refresh();
      }
    }
  }
  private async cancelConnect() {
    const pending = this.connecting;
    if (!pending) return;
    try {
      await this.bridge.request("mcp.connect.cancel", {
        operationId: pending.operationId,
      });
    } catch (e) {
      if (this.active) this.notice.textContent = reason(e);
    }
  }
  private async disconnectNow() {
    const d = this.current();
    if (!d || this.pending) return;
    this.pending = true;
    this.listVersion++;
    this.updateControls();
    try {
      await this.bridge.request("mcp.disconnect", { id: d.config.id });
      if (this.active) {
        this.notice.textContent = "已断开。要关闭下次自动连接，请停用并保存。";
        await this.refresh();
      }
    } catch (e) {
      if (this.active) this.notice.textContent = reason(e);
    } finally {
      this.pending = false;
      if (this.active) this.updateControls();
    }
  }
  private reloadCurrent() {
    const d = this.current();
    const reload = async () => {
      this.drafts.delete(this.selected);
      await this.refresh();
    };
    if (d?.dirty)
      this.confirm({
        title: "重新读取已保存设置？",
        body: "此服务尚未保存的修改将被替换。",
        confirmLabel: "重新读取",
        action: reload,
        done: "已读取保存的配置。",
      });
    else void reload();
  }
  private removeCurrent() {
    const row = this.rows.find((s) => s.id === this.selected);
    if (!row) return;
    this.confirm({
      title: `移除“${row.name}”？`,
      body: `${row.url}\n将断开连接、移除配置并清除此地址保存的密钥。`,
      confirmLabel: "移除",
      done: "服务已移除。",
      action: async () => {
        this.listVersion++;
        await this.bridge.request("mcp.remove", {
          id: row.id,
          revision: row.revision,
        });
        this.drafts.delete(row.id);
        this.rows = this.rows.filter((s) => s.id !== row.id);
        this.selected = this.rows[0]?.id ?? "";
        await this.refresh();
      },
    });
  }
}
