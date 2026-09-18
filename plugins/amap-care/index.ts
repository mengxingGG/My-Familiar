import { definePlugin } from "../../packages/contracts/index.ts";
import { mcpCredentialScope } from "../mcp-client/index.ts";
export function unwrapMcp(result: any): any {
  if (result?.isError) throw new Error("高德查询失败");
  let data = result?.structuredContent ?? result?.content ?? result;
  for (let i = 0; i < 4; i++) {
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        throw new Error("高德未返回可验证的结构化资料");
      }
    } else if (data?.data) data = data.data;
    else if (data?.result) data = data.result;
    else break;
  }
  return data;
}
const amount = (value: unknown) =>
  ((typeof value === "string" && value.trim()) || typeof value === "number") &&
  Number.isFinite(Number(value)) &&
  Number(value) > 0
    ? Number(value)
    : undefined;
export function restaurantLine(poi: any, detail: any, route: any): string {
  const price = amount(
    detail?.business?.cost ??
      detail?.biz_ext?.cost ??
      poi?.business?.cost ??
      poi?.biz_ext?.cost,
  );
  const seconds = amount(
    route?.route?.paths?.[0]?.duration ?? route?.paths?.[0]?.duration,
  );
  return `${String(poi.name).slice(0, 80)}：${seconds ? `步行约 ${Math.ceil(seconds / 60)} 分钟` : "步行时间暂缺"}，${price ? `参考人均 ¥${price}（以到店为准）` : "人均价格暂缺"}。`;
}
export const amapCare = definePlugin({
  manifest: {
    manifestVersion: 1,
    id: "familiar.amap-care",
    version: "0.3.0",
    provides: ["companion.places"],
    requires: ["mcp.manager", "secrets.local"],
    permissions: ["network.amap"],
  },
  start(ctx) {
    ctx.require("network.amap");
    const mcp = ctx.use("mcp.manager");
    ctx.provide("companion.places", {
      async nearby(location, signal) {
        const config = (await mcp.list()).find(
          (c) => c.enabled && c.url === "https://mcp.amap.com/mcp",
        );
        if (!config) throw new Error("尚未启用高德 MCP");
        const key = ctx.use("secrets.local").get(mcpCredentialScope(config));
        if (!key) throw new Error("请先保存高德 Web 服务 Key");
        const url = new URL(
          "https://restapi.amap.com/v3/assistant/coordinate/convert",
        );
        url.searchParams.set("key", key);
        url.searchParams.set("coordsys", "gps");
        url.searchParams.set(
          "locations",
          `${location.longitude.toFixed(6)},${location.latitude.toFixed(6)}`,
        );
        let converted: any;
        try {
          const response = await fetch(url, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            redirect: "error",
          });
          if (!response.ok) throw new Error();
          converted = await response.json();
        } catch {
          throw new Error("高德坐标转换失败，暂不提供附近建议");
        }
        if (
          converted.status !== "1" ||
          !/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(converted.locations)
        )
          throw new Error("高德未返回有效坐标");
        const origin = converted.locations;
        const data = unwrapMcp(
          await mcp.callReadOnly(
            config.id,
            "maps_around_search",
            { location: origin, keywords: "餐厅", radius: "1500" },
            signal,
          ),
        );
        const pois = (Array.isArray(data?.pois) ? data.pois : [])
          .filter(
            (p: any) => typeof p.name === "string" && typeof p.id === "string",
          )
          .slice(0, 2);
        if (!pois.length) throw new Error("高德暂未找到可确认的附近餐馆");
        const lines: string[] = [];
        for (const poi of pois) {
          let detail: any = {},
            route: any = {};
          try {
            const result = unwrapMcp(
              await mcp.callReadOnly(
                config.id,
                "maps_search_detail",
                { id: poi.id },
                signal,
              ),
            );
            detail = result.pois?.[0] ?? result.poi ?? result;
          } catch {
            signal.throwIfAborted();
          }
          const destination = detail.location ?? poi.location;
          if (
            typeof destination === "string" &&
            /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(destination)
          ) {
            try {
              route = unwrapMcp(
                await mcp.callReadOnly(
                  config.id,
                  "maps_direction_walking",
                  { origin, destination },
                  signal,
                ),
              );
            } catch {
              signal.throwIfAborted();
            }
          }
          lines.push(restaurantLine(poi, detail, route));
        }
        return "高德刚查到的附近选择：\n" + lines.join("\n");
      },
    });
  },
});
