import { definePlugin } from "../packages/contracts/index.ts";
import { personaPrompt, personas } from "../plugins/conversation/config.ts";
// 保留已有会话测试的模型与存储隔离，新工具链在 agent.test.ts 单独覆盖。
export const conversationFixture = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "test.conversation-fixture",
    version: "1",
    provides: [
      "agent.chat",
      "agent.tools",
      "memory.files",
      "skills.catalog",
      "persona.catalog",
    ],
    requires: ["llm.chat"],
  },
  start(ctx) {
    ctx.provide("persona.catalog", {
      list: () => personas.map((p) => ({ ...p })),
      prompt: (c) => personaPrompt(c.persona),
    });
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
      diary: async () => "",
      list: async () => [],
      read: async () => ({ text: "", revision: "" }),
      write: async () => {},
      remember: async () => ({
        path: "CORE.md",
        action: "add",
        written: false,
        entries: 0,
        characters: 0,
      }),
      note: async () => ({
        path: "lessons/fixture.md",
        action: "add",
        written: false,
        entries: 0,
        characters: 0,
      }),
      search: async () => [],
      status: () => ({
        root: "",
        core: { characters: 0, limit: 2000 },
        index: { characters: 0, limit: 1000, omitted: 0 },
      }),
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
