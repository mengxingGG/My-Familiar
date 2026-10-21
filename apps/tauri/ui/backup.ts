import type {
  MobileBridge,
  BackupPreview,
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
const field = (text: string, input: HTMLElement) => {
  const n = el("label", text, "field");
  input.setAttribute("aria-label", text);
  n.append(input);
  return n;
};
const password = () => {
  const n = el("input");
  n.type = "password";
  n.maxLength = 256;
  n.autocomplete = "off";
  return n;
};
type Confirm = {
  title: string;
  body: string;
  confirmLabel: string;
  action: () => Promise<unknown>;
  done: string;
  tone?: "danger" | "primary";
};
const reason = (e: any) =>
  (
    ({
      BACKUP_PASSWORD: "密码至少需要 10 个字符。",
      BACKUP_DECRYPT: "密码不正确，或文件已损坏。请核对后重试。",
      INVALID_BACKUP: "这不是受支持的灵伴加密迁移文件。",
      LIMIT:
        "资料超过导入上限：单文件 2 MiB、总记忆 20 MiB，核心规则最多 2000 字符。",
      BUSY: "请先停止当前回复和语音，再导出或导入。",
      CONFLICT: "预览后资料已变化，请重新读取文件并核对。",
      NOT_FOUND: "导入预览已过期，请重新选择文件。",
      BACKUP_RECOVERY: "未能完整恢复，请使用相同密码恢复上次导入前状态。",
    }) as Record<string, string>
  )[e?.code] ?? "操作未确认，请核对当前配置后重试。";

export class BackupView {
  readonly page = el("section", "", "page backup-page");
  readonly heading = el("h1", "数据迁移");
  private body = el("div", "", "page-body");
  private notice = el("p", "", "form-status");
  private exportPassword = password();
  private repeat = password();
  private importPassword = password();
  private keys = el("input");
  private chosen = el("p", "尚未选择文件。", "block-hint");
  private previewBox = el("div", "", "panel panel-form");
  private token?: string;
  private preview?: BackupPreview;
  private busy = false;
  private active = false;
  private generation = 0;
  constructor(
    private bridge: MobileBridge,
    back: HTMLButtonElement,
    private confirm: (v: Confirm) => void,
  ) {
    this.page.hidden = true;
    this.heading.tabIndex = -1;
    this.heading.id = "backup-heading";
    this.page.setAttribute("aria-labelledby", this.heading.id);
    this.keys.type = "checkbox";
    this.keys.checked = true;
    const head = el("header", "", "pagebar");
    head.append(back, this.heading);
    const scope = el(
      "p",
      "迁移核心规则、日记、教训、扩展记忆、模型连接、昵称和宠物设置。模型密钥可选。聊天原文、附件、第三方登录和系统授权不在本次迁移范围内。文件与密码请分开保存，丢失密码无法解密。",
      "block-hint",
    );
    const out = el("div", "", "panel panel-form");
    out.append(
      field("导出密码（至少 10 字符）", this.exportPassword),
      field("再次输入导出密码", this.repeat),
      field("包含模型密钥（文件整体加密）", this.keys),
      button("加密导出单文件", () => void this.export(), "primary"),
    );
    const incoming = el("div", "", "panel panel-form");
    incoming.append(
      button("选择旧版迁移文件", () => void this.choose()),
      this.chosen,
      field("迁移文件密码", this.importPassword),
      button("解密并预览", () => void this.inspect(false), "primary"),
      button("恢复上次导入前状态", () => void this.inspect(true)),
    );
    this.previewBox.hidden = true;
    this.body.append(
      scope,
      this.notice,
      el("h2", "导出", "block-title"),
      out,
      el("h2", "导入与恢复", "block-title"),
      incoming,
      this.previewBox,
    );
    this.page.append(head, this.body);
  }
  open() {
    this.active = true;
  }
  close() {
    this.active = false;
    this.generation++;
    this.exportPassword.value = "";
    this.repeat.value = "";
    this.importPassword.value = "";
    if (this.preview)
      void this.bridge
        .request("backup.cancel", { id: this.preview.id })
        .catch(() => {});
    this.preview = undefined;
    this.previewBox.hidden = true;
  }
  private async run(action: () => Promise<void>) {
    if (this.busy || !this.active) return;
    this.busy = true;
    const generation = this.generation;
    this.notice.textContent = "正在处理…";
    this.lock(true);
    try {
      await action();
    } catch (e) {
      if (this.active && generation === this.generation)
        this.notice.textContent = reason(e);
    } finally {
      this.busy = false;
      this.lock(false);
    }
  }
  private lock(value: boolean) {
    this.body
      .querySelectorAll("button,input")
      .forEach((n) => ((n as HTMLInputElement).disabled = value));
  }
  private async export() {
    await this.run(async () => {
      const password = this.exportPassword.value;
      if (password.length < 10 || password !== this.repeat.value) {
        this.notice.textContent = "请输入至少 10 字符的密码，并确保两次一致。";
        return;
      }
      this.exportPassword.value = "";
      this.repeat.value = "";
      const result = await this.bridge.request("backup.export", {
        password,
        includeKeys: this.keys.checked,
      });
      if (this.active)
        this.notice.textContent = result.saved
          ? "加密文件已保存。请保管好文件与密码。"
          : "已取消保存，没有导出文件。";
    });
  }
  private async choose() {
    await this.run(async () => {
      if (this.preview)
        await this.bridge.request("backup.cancel", { id: this.preview.id });
      this.preview = undefined;
      this.previewBox.hidden = true;
      const result = await this.bridge.request("backup.choose", undefined);
      this.token = result.token ?? undefined;
      this.chosen.textContent = this.token
        ? "已选择加密迁移文件，请输入密码并预览。"
        : "已取消选择。";
      this.notice.textContent = "";
    });
  }
  private async inspect(rollback: boolean) {
    await this.run(async () => {
      const password = this.importPassword.value;
      this.importPassword.value = "";
      if (!rollback && !this.token) {
        this.notice.textContent = "请先选择旧版导出的文件。";
        return;
      }
      const value = rollback
        ? await this.bridge.request("backup.recovery", { password })
        : await this.bridge.request("backup.inspect", {
            token: this.token!,
            password,
          });
      if (!this.active) {
        await this.bridge.request("backup.cancel", { id: value.id });
        return;
      }
      this.preview = value;
      this.previewBox.replaceChildren(
        el("b", rollback ? "恢复预览" : "导入预览"),
        el(
          "p",
          `来源 ${value.sourceVersion} · ${new Date(value.createdAt).toLocaleString()}`,
        ),
        el(
          "p",
          `${value.memoryFiles} 份记忆，${value.conflicts} 份同名内容将被覆盖，${value.modelKeys} 个模型密钥。`,
        ),
      );
      for (const m of value.models)
        this.previewBox.append(
          el(
            "p",
            `${m.kind} · ${m.model || "未选模型"}\n${m.baseUrl}`,
            "block-hint",
          ),
        );
      this.previewBox.append(
        el(
          "p",
          rollback
            ? "恢复会替换当前记忆和模型配置，移除恢复点中没有的记忆。"
            : "同名记忆与模型配置会替换；当前其他记忆保留。先核对上面的模型地址，导入后密钥将用于这些连接。",
          "block-hint",
        ),
        button(
          rollback ? "确认恢复" : "确认导入",
          () =>
            this.confirm({
              title: rollback ? "恢复导入前的数据？" : "导入旧版配置？",
              body: rollback
                ? "当前记忆和模型配置将被恢复点替换。"
                : "同名记忆、模型、昵称和宠物设置将被替换。导入前会保存加密恢复点，密码与此文件相同。",
              confirmLabel: rollback ? "恢复数据" : "导入配置",
              action: async () => {
                const r = await this.bridge.request("backup.apply", {
                  id: value.id,
                });
                this.preview = undefined;
                this.previewBox.hidden = true;
                this.notice.textContent = r.imported
                  ? "已完成，记忆与模型配置已生效。恢复点使用本次文件的密码。"
                  : "结果未确认，请检查当前配置。";
                return r;
              },
              done: "",
            }),
          "primary",
        ),
      );
      this.previewBox.hidden = false;
      this.notice.textContent = "请核对后确认；预览 5 分钟后失效。";
    });
  }
}
