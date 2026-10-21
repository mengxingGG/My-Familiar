import type {
  MobileBridge,
  MobileContext,
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
const fields = {
  goals: "当前目标",
  constraints: "约束与更正",
  facts: "已知事实",
  decisions: "决定",
  progress: "已完成",
  pending: "待办",
  uncertainties: "待确认",
  artifacts: "资料与位置",
};

export class ContextView {
  readonly page = node("section", "", "page context-page");
  readonly heading = node("h1", "会话上下文");
  private readonly status = node("p", "", "form-status");
  private readonly metrics = node("div", "", "context-metrics");
  private readonly summary = node("section", "", "panel panel-form");
  private readonly archive = node("details", "", "voice-details");
  private readonly source = node("pre", "", "library-source");
  private readonly archiveStatus = node("p", "", "block-hint");
  private readonly query = node("input");
  private readonly refreshButton: HTMLButtonElement;
  private readonly sourceButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  private conversationId = "";
  private checkpoint = "";
  private next: number | null = null;
  private previous?: string;
  private active = false;
  private disposed = false;
  private epoch = 0;
  private read = 0;
  private archiveRead = 0;
  constructor(
    private readonly bridge: MobileBridge,
    back: HTMLElement,
  ) {
    this.page.hidden = true;
    this.heading.tabIndex = -1;
    const title = node("div", "", "pagebar-title");
    title.append(this.heading);
    const bar = node("header", "", "pagebar");
    bar.append(back, title);
    const body = node("div", "", "page-body context-body");
    this.refreshButton = button("刷新上下文状态", () => void this.refresh());
    this.sourceButton = button("读取本段原文", () => void this.load(0));
    this.nextButton = button("下一页原文", () => {
      if (this.next !== null) void this.load(this.next);
    });
    this.previousButton = button("更早的压缩记录", () => {
      if (this.previous) {
        this.checkpoint = this.previous;
        void this.load(0);
      }
    });
    this.query.type = "search";
    this.query.placeholder = "在本段原文内查找";
    this.query.maxLength = 200;
    this.query.setAttribute("aria-label", "查找压缩原文");
    const search = node("form", "", "library-toolbar");
    search.append(
      this.query,
      button("查找", () => void this.load(0)),
    );
    search.onsubmit = (e) => {
      e.preventDefault();
      void this.load(0);
    };
    const actions = node("div", "", "library-editor-actions");
    actions.append(this.sourceButton, this.nextButton, this.previousButton);
    this.archive.append(
      node("summary", "回查压缩前原文"),
      search,
      this.archiveStatus,
      this.source,
      actions,
    );
    this.archive.hidden = true;
    this.status.setAttribute("role", "status");
    body.append(
      node(
        "p",
        "输入用量记录上次准备请求时的系统规则、记忆和会话；工具说明单独预留空间。压缩触发点已扣除工具预留量，压缩后原文仍可回查。",
        "block-hint",
      ),
      this.refreshButton,
      this.status,
      this.metrics,
      this.summary,
      this.archive,
    );
    this.page.append(bar, body);
    this.pages();
  }
  open(conversationId: string) {
    this.active = true;
    this.epoch++;
    this.conversationId = conversationId;
    this.checkpoint = "";
    this.next = null;
    this.previous = undefined;
    this.sourceButton.disabled = false;
    this.nextButton.disabled = false;
    this.previousButton.disabled = false;
    this.metrics.replaceChildren();
    this.summary.replaceChildren();
    this.archive.hidden = true;
    this.source.textContent = "";
    this.query.value = "";
    this.status.textContent = "正在读取…";
    void this.refresh();
  }
  close() {
    this.active = false;
    this.epoch++;
    this.read++;
    this.archiveRead++;
  }
  dispose() {
    this.disposed = true;
    this.close();
  }
  private pages() {
    this.nextButton.hidden = this.next === null;
    this.previousButton.hidden = !this.previous;
  }
  private async refresh() {
    const id = ++this.read,
      epoch = this.epoch;
    this.refreshButton.disabled = true;
    try {
      const value = await this.bridge.request("conversation.context", {
        conversationId: this.conversationId,
      });
      if (id !== this.read || epoch !== this.epoch || this.disposed) return;
      this.render(value);
      this.status.textContent = `已读取 · ${new Date().toLocaleTimeString()}`;
    } catch {
      if (id === this.read && epoch === this.epoch)
        this.status.textContent = "未能读取上下文状态，请重试。";
    } finally {
      if (id === this.read) this.refreshButton.disabled = false;
    }
  }
  private render(value: MobileContext) {
    this.metrics.replaceChildren();
    const stat = (name: string, text: string) => {
      const card = node("div", "", "panel context-metric");
      card.append(node("small", name), node("b", text));
      this.metrics.append(card);
    };
    const s = value.status;
    if (s) {
      stat(
        s.exact ? "输入 token（已计数）" : "输入 token（保守估算）",
        s.inputTokens.toLocaleString(),
      );
      stat("请求输入预算（含工具）", s.inputBudget.toLocaleString());
      stat(
        "预算来源",
        { model: "模型目录", manual: "手动窗口", fallback: "暂用默认窗口" }[
          s.limitSource
        ],
      );
      stat(
        "自动压缩触发点",
        s.compactThreshold === undefined
          ? "尚未记录"
          : s.compactThreshold.toLocaleString(),
      );
      stat("已压缩次数", String(s.compactions));
      stat(
        "保留消息 / 已压缩消息",
        `${s.retainedMessages} / ${s.trimmedMessages}`,
      );
      if (s.usage) {
        const u = s.usage;
        stat(
          "最近服务报告：输入 / 输出",
          `${u.inputTokens ?? "未报告"} / ${u.outputTokens ?? "未报告"}`,
        );
        stat(
          "最近服务报告：缓存命中 / 写入",
          `${u.cachedInputTokens ?? "未报告"} / ${u.cacheWriteTokens ?? "未报告"}`,
        );
      }
    } else
      this.metrics.append(
        node(
          "p",
          value.active
            ? "尚未准备过模型请求，发送消息后可查看用量。"
            : "当前查看历史会话；实时用量在切换到该会话后提供。",
          "block-hint",
        ),
      );
    this.summary.replaceChildren();
    const checkpoint = value.checkpoint;
    this.archive.hidden = !checkpoint;
    if (!checkpoint) {
      this.archiveRead++;
      this.checkpoint = "";
      this.source.textContent = "";
      this.next = null;
      this.previous = undefined;
      this.sourceButton.disabled = false;
      this.nextButton.disabled = false;
      this.previousButton.disabled = false;
      this.pages();
      this.summary.append(node("p", "这段对话尚未产生压缩摘要。"));
      return;
    }
    this.summary.append(
      node(
        "h2",
        `交接摘要 · 第 ${checkpoint.compactions} 次`,
        "library-file-title",
      ),
      node("p", new Date(checkpoint.created).toLocaleString(), "block-hint"),
    );
    if (checkpoint.truncated)
      this.summary.append(
        node("p", "摘要过长，这里只显示部分内容；请回查原文。", "block-hint"),
      );
    for (const [key, title] of Object.entries(fields)) {
      const items = checkpoint.summary[key as keyof typeof fields];
      if (!items.length) continue;
      const section = node("section");
      section.append(node("h3", title));
      const list = node("ul");
      for (const item of items) list.append(node("li", item));
      section.append(list);
      this.summary.append(section);
    }
    if (this.checkpoint !== checkpoint.id) {
      this.archiveRead++;
      this.checkpoint = checkpoint.id;
      this.next = null;
      this.previous = undefined;
      this.sourceButton.disabled = false;
      this.nextButton.disabled = false;
      this.previousButton.disabled = false;
      this.source.textContent = "";
      this.archiveStatus.textContent = "按需读取，不会发送给模型。";
      this.pages();
    }
  }
  private async load(offset: number) {
    if (!this.checkpoint) return;
    const id = ++this.archiveRead,
      epoch = this.epoch,
      checkpoint = this.checkpoint,
      query = this.query.value;
    this.sourceButton.disabled = true;
    this.nextButton.disabled = true;
    this.previousButton.disabled = true;
    this.archiveStatus.textContent = "正在读取原文…";
    try {
      const value = await this.bridge.request("context.archive", {
        conversationId: this.conversationId,
        checkpoint,
        offset,
        query,
      });
      if (id !== this.archiveRead || epoch !== this.epoch || this.disposed)
        return;
      this.source.textContent = value.text;
      this.next = value.nextOffset;
      this.previous = value.previous;
      this.archiveStatus.textContent = `本段共 ${value.totalCharacters.toLocaleString()} 字符，每页最多 16000 字符。`;
      this.pages();
    } catch {
      if (id === this.archiveRead && epoch === this.epoch)
        this.archiveStatus.textContent = "未能读取该记录，请刷新后再试。";
    } finally {
      if (id === this.archiveRead) {
        this.sourceButton.disabled = false;
        this.nextButton.disabled = false;
        this.previousButton.disabled = false;
      }
    }
  }
}
