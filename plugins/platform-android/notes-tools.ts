/** 仅向声明笔记 Intent 的应用交接，是否保存由接收应用和用户确认。 */
export const notesTools = [
  {
    name: "android_notes_targets",
    method: "notes.targets",
    description:
      "查标准笔记 Intent 接收端 target。prefilled 带标题/正文；blank 仅空白页。无接收端用 files，不访问私有数据库。",
    properties: {},
    required: [],
  },
  {
    name: "android_notes_compose",
    method: "notes.compose",
    description:
      "复制刚查询的明确 target，交接标题/正文。handoff 非已保存，须用户在笔记应用确认。blank 的 title/text 须空。相同交接复用 operationId；unknown 不换编号重试。",
    properties: {
      operationId: { type: "string", pattern: "^[A-Za-z0-9_-]{8,80}$" },
      target: {
        type: "object",
        properties: {
          component: { type: "string", maxLength: 500 },
          label: { type: "string", maxLength: 200 },
          mode: { enum: ["prefilled", "blank"] },
        },
        required: ["component", "label", "mode"],
        additionalProperties: false,
      },
      title: { type: "string", maxLength: 200 },
      text: { type: "string", maxLength: 10000 },
    },
    required: ["operationId", "target", "title", "text"],
  },
];
