// 部分本地模板将推理放在正文开头；跨分片保留标签边界，避免泄露推理。
export function visibleText() {
  let state: "probe" | "thinking" | "visible" = "probe",
    pending = "";
  return {
    push(text: string): string {
      if (state === "visible") return text;
      pending += text;
      if (state === "probe") {
        const head = pending.trimStart();
        if (head.startsWith("<think>")) {
          state = "thinking";
          pending = head.slice(7);
        } else if ("<think>".startsWith(head) && pending.length < 256)
          return "";
        else {
          state = "visible";
          const out = pending;
          pending = "";
          return out;
        }
      }
      const end = pending.indexOf("</think>");
      if (end < 0) {
        pending = pending.slice(-7);
        return "";
      }
      state = "visible";
      const out = pending.slice(end + 8);
      pending = "";
      return out;
    },
    finish(): string {
      return state === "probe" ? pending : "";
    },
  };
}
