import {
  definePlugin,
  profileDefaults,
  type ProviderDefinition,
} from "../../packages/contracts/index.ts";
export const llmRegistry = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.llm-registry",
    version: "0.1.0",
    provides: ["llm.registry"],
    requires: [],
  },
  start(ctx) {
    const providers = new Map<string, ProviderDefinition>();
    ctx.provide("llm.registry", {
      register(provider) {
        if (providers.has(provider.id))
          throw new Error(`供应商重复：${provider.id}`);
        providers.set(provider.id, provider);
        return () => {
          providers.delete(provider.id);
        };
      },
      get(id) {
        const provider = providers.get(id);
        if (!provider) throw new Error(`供应商不可用：${id}`);
        return provider;
      },
      list: () =>
        [...providers.values()].map((p) => ({
          id: p.id,
          name: p.name,
          requiresKey: p.requiresKey,
          defaults: {
            ...structuredClone(profileDefaults),
            kind: p.id,
            baseUrl: p.baseUrl,
          },
        })),
    });
    ctx.effect(() => providers.clear());
  },
});
