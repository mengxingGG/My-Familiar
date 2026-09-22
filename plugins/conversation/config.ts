import {
  definePlugin,
  defaults,
  type ConfigSection,
  type Settings,
} from "../../packages/contracts/index.ts";
export const personas = [
  {
    id: "gentle",
    name: "温柔陪伴",
    description: "先倾听感受，再给轻柔、具体的回应，不催促、不说教。",
    example: "今天辛苦了。要先歇一会儿，还是和我说说？",
  },
  {
    id: "thorough",
    name: "细致周到",
    description: "关注细节、前提和遗漏，把复杂事情分步骤说明；简单问题仍简答。",
    example: "我们一步步来：先确认目标，再列步骤，最后检查有没有遗漏。",
  },
  {
    id: "direct",
    name: "直白理性",
    description:
      "表达平实、直接，事实和结论优先，少修饰；保持礼貌，不冷嘲热讽。",
    example: "先处理最紧急的一项。完成后再看下一项。",
  },
  {
    id: "enthusiastic",
    name: "热情活泼",
    description: "回应积极，有轻快的语气和适量幽默；不夸张吹捧、不连续催促。",
    example: "来啦！今天想先搞定哪件事？我陪你开个好头。",
  },
  {
    id: "concise",
    name: "简洁高效",
    description:
      "默认一到三句，先给结论和下一步；用户要求详细时再展开，不省略关键限制。",
    example: "先做最急的一件。需要我列步骤吗？",
  },
] as const;
export function personaPrompt(
  persona: Settings["persona"],
  recommendation = "gentle",
) {
  const style = persona.style === "character" ? recommendation : persona.style;
  const preset = personas.find((p) => p.id === style);
  return `你的名字是${persona.name}。你是陪伴用户的桌面伙伴，用自然的中文交流。\n${preset?.description ?? ""}\n${persona.instruction}`;
}
export const personaSchema: ConfigSection<Settings["persona"]> = {
  defaults: defaults.persona,
  validate(value) {
    const v = value as Settings["persona"];
    if (
      !v ||
      typeof v.name !== "string" ||
      !v.name.trim() ||
      v.name.length > 40
    )
      throw new Error("名字需要 1—40 个字符");
    if (typeof v.instruction !== "string" || v.instruction.length > 6000)
      throw new Error("人格设定过长");
    // 旧版自由文本按原样保留，不被新增的默认性格覆盖。
    const style = v.style ?? "custom";
    if (!["character", "custom", ...personas.map((p) => p.id)].includes(style))
      throw new Error("请选择有效的性格");
    return { name: v.name.trim(), instruction: v.instruction, style };
  },
};
export const personaConfig = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.persona-config",
    version: "0.1.0",
    provides: ["config.persona", "persona.catalog"],
    requires: ["character.catalog"],
  },
  start(ctx) {
    ctx.provide("config.persona", personaSchema);
    ctx.provide("persona.catalog", {
      list: () => personas.map((p) => ({ ...p })),
      prompt: (config) =>
        personaPrompt(
          config.persona,
          ctx.use("character.catalog").get(config.pet.character)
            .recommendedPersona,
        ),
    });
  },
});
