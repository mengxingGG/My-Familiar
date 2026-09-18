import {
  definePlugin,
  type ProviderDefinition,
} from "../../packages/contracts/index.ts";
export function providerPlugin(definition: ProviderDefinition) {
  return definePlugin({
    manifest: {
      manifestVersion: 1,
      id: `familiar.provider-${definition.id}`,
      version: "0.1.0",
      provides: [],
      requires: ["llm.registry"],
      permissions: ["network.model"],
    },
    start(ctx) {
      ctx.require("network.model");
      ctx.effect(
        ctx
          .use("llm.registry")
          .register({
            ...definition,
            stream: (input) =>
              definition.stream({
                ...input,
                signal: AbortSignal.any([input.signal, ctx.abort.signal]),
              }),
            models: (input) =>
              definition.models({
                ...input,
                signal: AbortSignal.any([input.signal, ctx.abort.signal]),
              }),
            ...(definition.countTokens
              ? {
                  countTokens: (
                    input: Parameters<
                      NonNullable<ProviderDefinition["countTokens"]>
                    >[0],
                  ) =>
                    definition.countTokens!({
                      ...input,
                      signal: AbortSignal.any([input.signal, ctx.abort.signal]),
                    }),
                }
              : {}),
          }),
      );
    },
  });
}
