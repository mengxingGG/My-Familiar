import { definePlugin } from "../packages/contracts/index.ts";
// 保留已有会话测试的模型与存储隔离，新工具链在 agent.test.ts 单独覆盖。
export const conversationFixture = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "test.conversation-fixture",
    version: "1",
    provides: ["agent.chat", "agent.tools", "memory.files", "skills.catalog"],
    requires: ["llm.chat"],
  },
  start(ctx) {
    ctx.provide("agent.chat", {
      stream: (input) => ctx.use("llm.chat").stream(input),
    });
    ctx.provide("agent.tools", {
      list: () => [],
      register: () => () => {},
      run: async () => "",
    });
    ctx.provide("memory.files", {
      context: async () => "",
      record: async () => {},
      list: async () => [],
      read: async () => ({ text: "", revision: "" }),
      write: async () => {},
      remember: async () => ({ refined: false }),
      lesson: async () => "",
      search: async () => [],
      status: () => ({ root: "", refining: false }),
    });
    ctx.provide("skills.catalog", {
      list: async () => [],
      read: async () => "",
      install: async () => ({
        id: "",
        description: "",
        enabled: true,
        source: "",
      }),
      setEnabled: async () => {},
      remove: async () => {},
      prompt: async () => "",
    });
  },
});
