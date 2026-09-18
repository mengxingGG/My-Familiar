import test from "node:test";
import assert from "node:assert/strict";
import { trustedLocation } from "../plugins/location-windows/validation.ts";
import {
  careDefaults,
  careSlot,
  quietTime,
  localDay,
  validateCare,
} from "../plugins/companion-care/schedule.ts";
import { restaurantLine, unwrapMcp } from "../plugins/amap-care/index.ts";
import { validateMcp, amapPreset } from "../plugins/mcp-client/index.ts";
test("关怀按本地日期与时段运行，安静时段和已经触发的事件不重复", () => {
  const morning = new Date(2026, 8, 18, 9, 0);
  assert.equal(careSlot(careDefaults, morning, 16000, []), "greeting");
  assert.equal(
    careSlot(careDefaults, morning, 21 * 60000, ["greeting"]),
    "work",
  );
  const lunch = new Date(2026, 8, 18, 11, 45);
  assert.equal(careSlot(careDefaults, lunch, 3 * 3600000, []), "noon");
  assert.equal(careSlot(careDefaults, lunch, 3 * 3600000, ["noon"]), undefined);
  assert.equal(quietTime(careDefaults, new Date(2026, 8, 18, 23)), true);
  assert.equal(
    careSlot(careDefaults, new Date(2026, 8, 18, 23), 16000, []),
    undefined,
  );
  assert.equal(localDay(morning), "2026-09-18");
});
test("位置来源、精度和时效校验拒绝 IP 与猜测位置", () => {
  const value = {
    latitude: 25,
    longitude: 121,
    accuracy: 80,
    source: "WiFi",
    time: Date.now(),
  };
  assert.equal(trustedLocation(value).source, "WiFi");
  for (const source of ["IPAddress", "Unknown", "Default", "Obfuscated"])
    assert.throws(() => trustedLocation({ ...value, source }));
  assert.throws(() =>
    trustedLocation({ ...value, time: Date.now() - 3600000 }),
  );
  assert.throws(() => trustedLocation({ ...value, accuracy: 10000 }));
});
test("内置关怀不暴露细分开关，自定义提醒独立添加、勾选、去重，总开关控制全部", () => {
  const custom = {
    id: "water",
    label: "喝水",
    prompt: "轻轻提醒喝杯水",
    time: "15:30",
    enabled: false,
  };
  let c = validateCare({ ...careDefaults, custom: [custom] });
  const now = new Date(2026, 8, 18, 15, 31);
  assert.equal(careSlot(c, now, 4 * 3600000, []), undefined);
  c.custom[0].enabled = true;
  assert.equal(careSlot(c, now, 4 * 3600000, []), "custom:water");
  assert.equal(careSlot(c, now, 4 * 3600000, ["custom:water"]), undefined);
  assert.equal(
    careSlot({ ...c, enabled: false }, now, 4 * 3600000, []),
    undefined,
  );
  assert.throws(() =>
    validateCare({ ...c, custom: [{ ...custom, time: "25:00" }] }),
  );
  assert.throws(() => validateCare({ ...c, custom: [custom, custom] }));
  assert.deepEqual(
    Object.keys(
      validateCare({
        ...careDefaults,
        greeting: false,
        planning: false,
      } as any),
    ).sort(),
    ["custom", "enabled", "location", "nearby"],
  );
});
test("高德查询密钥独立配置，餐馆价格与时间只能来自真实返回字段", () => {
  assert.equal(validateMcp(amapPreset).auth?.kind, "query");
  assert.throws(() =>
    validateMcp({ ...amapPreset, url: amapPreset.url + "?key=secret" }),
  );
  const missing = restaurantLine(
    { name: "示例餐厅", distance: "1000" },
    {},
    {},
  );
  assert.match(missing, /时间暂缺/);
  assert.match(missing, /价格暂缺/);
  assert.doesNotMatch(missing, /分钟/);
  assert.match(
    restaurantLine(
      { name: "示例餐厅" },
      { biz_ext: { cost: "38" } },
      { route: { paths: [{ duration: "601" }] } },
    ),
    /11 分钟.*38/,
  );
  assert.deepEqual(unwrapMcp({ content: '{"pois":[]}' }), { pois: [] });
  assert.throws(() => unwrapMcp({ isError: true, content: "error" }));
});
