const operationId = { type: "string", pattern: "^[A-Za-z0-9_-]{8,80}$" };
const calendarTarget = {
  type: "object",
  properties: {
    calendarId: { type: "string", pattern: "^[0-9]+$" },
    name: { type: "string", maxLength: 2000 },
    revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
    eventCount: { type: "integer", minimum: 0, maximum: 100000 },
  },
  required: ["calendarId", "name", "revision", "eventCount"],
  additionalProperties: false,
};
const calendarFields = {
  name: { type: "string", minLength: 1, maxLength: 200 },
  color: { type: "string", pattern: "^#[A-Fa-f0-9]{6}$" },
  timeZone: { type: "string", maxLength: 100 },
  visible: { type: "boolean" },
};
export const calendarExtraTools = [
  {
    name: "android_calendar_local_create",
    method: "calendar.local.create",
    description:
      "新建由灵伴管理的系统本地日历，不连接云账号。operationId 用于防重；unknown 先 list 核实。",
    properties: { operationId, ...calendarFields },
    required: ["operationId", "name", "color", "timeZone"],
  },
  {
    name: "android_calendar_settings_update",
    method: "calendar.settings.update",
    description:
      "复制 list.target 修改日历名称、颜色、时区或可见性。改时区不搬动现有事件时间；隐藏会影响 Instances 查询。",
    properties: {
      operationId,
      target: calendarTarget,
      patch: {
        type: "object",
        properties: calendarFields,
        minProperties: 1,
        additionalProperties: false,
      },
    },
    required: ["operationId", "target", "patch"],
  },
  {
    name: "android_calendar_local_delete",
    method: "calendar.local.delete",
    description:
      "删除灵伴自建的本地日历及全部日程；复制最新 list.target 并确认事件数量。外部/云日历须在原应用处理。此操作无法由变更日志完整恢复。",
    properties: { operationId, target: calendarTarget },
    required: ["operationId", "target"],
  },
  {
    name: "android_calendar_open",
    method: "calendar.open",
    description:
      "在系统日历中查看或编辑日程，或打开新建界面。复杂的外部重复规则和邀请可在原应用处理；交接成功不代表保存成功，之后须查询核实。",
    properties: {
      operationId,
      mode: { enum: ["view", "edit", "insert"] },
      eventId: { type: "string", pattern: "^[0-9]+$" },
    },
    required: ["operationId", "mode"],
  },
];
export const attendeeSchema = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: 200 },
    email: { type: "string", minLength: 3, maxLength: 320 },
    type: { enum: ["required", "optional", "none"] },
    status: { enum: ["none", "accepted", "declined", "invited", "tentative"] },
  },
  required: ["name", "email", "type", "status"],
  additionalProperties: false,
};
