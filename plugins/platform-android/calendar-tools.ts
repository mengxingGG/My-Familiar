import { calendarRecurrence } from "./calendar-create.ts";
import { attendeeSchema } from "./calendar-extra-tools.ts";

const timestamp = {
  type: "string",
  maxLength: 40,
};
const target = {
  type: "object",
  properties: {
    eventId: { type: "string", pattern: "^[0-9]+$" },
    revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
    title: { type: "string", maxLength: 2000 },
    start: { type: "string", maxLength: 40 },
    exceptionCount: { type: "integer", minimum: 0, maximum: 50 },
  },
  required: ["eventId", "revision", "title", "start"],
  additionalProperties: false,
};
const operationId = { type: "string", pattern: "^[A-Za-z0-9_-]{8,80}$" };
const patchFields = {
  title: { type: "string", minLength: 1, maxLength: 200 },
  description: { type: "string", maxLength: 6000 },
  location: { type: "string", maxLength: 500 },
  start: timestamp, end: timestamp, timeZone: { type: "string", maxLength: 100 },
  availability: { enum: ["busy", "free", "tentative"] }, visibility: { enum: ["default", "private", "public"] },
};
const instanceTarget = {
  type: "object",
  properties: {
    seriesId: { type: "string", pattern: "^[0-9]+$" }, originalStart: timestamp,
    revision: { type: "string", pattern: "^[a-f0-9]{64}$" },
    title: { type: "string", maxLength: 2000 }, start: timestamp, end: timestamp,
    timeZone: { type: "string", maxLength: 100 }, allDay: { type: "boolean" }, cancelled: { type: "boolean" },
  },
  required: ["seriesId", "originalStart", "revision", "title", "start", "end", "timeZone", "allDay", "cancelled"],
  additionalProperties: false,
};
const scope = {
  enum: ["event", "series"],
  description:
    "event 普通事件；series 整个系列。",
};
const reminders = {
  type: "array",
  items: { type: "integer", minimum: 0, maximum: 40320 },
  uniqueItems: true,
  maxItems: 5,
  description:
    "提前分钟数；0 开始时，空数组关闭。",
};

/** 日历写入仍通过共享工具批准；目标同时带可读标题/时间与执行时版本。 */
export const calendarManagementTools = [
  {
    name: "android_calendar_read",
    method: "calendar.read",
    description:
    "读日程/提醒/例外；整组改删前复制 target，单次用 instance_read。时间均带 UTC 偏移。",
    properties: { eventId: { type: "string", pattern: "^[0-9]+$" } },
    required: ["eventId"],
  },
  {
    name: "android_calendar_update",
    method: "calendar.update",
    description:
      "复制 read.target；series 重排须同时给 start/end/timeZone/recurrence，且无例外/排除规则。元数据保留例外，全天类型不变。unknown 先查，不换操作号重试。",
    properties: {
      operationId,
      target,
      scope,
      patch: {
        type: "object",
        properties: {
          ...patchFields, recurrence: calendarRecurrence,
        },
        minProperties: 1,
        additionalProperties: false,
      },
    },
    required: ["operationId", "target", "scope", "patch"],
  },
  {
    name: "android_calendar_delete",
    method: "calendar.delete",
    description:
      "复制 read.target；series 删整个系列及例外，单次用 instance_cancel。恢复资料仅字段/提醒。unknown 先查，不换操作号重删。",
    properties: { operationId, target, scope },
    required: ["operationId", "target", "scope"],
  },
  {
    name: "android_calendar_reminders_set",
    method: "calendar.reminders",
    description:
      "复制 read.target，替换提醒；已有例外保持原提醒。通知由日历应用负责。",
    properties: { operationId, target, scope, minutes: reminders, method: { enum: ["default", "alert", "email", "sms"], description: "须在 list.allowedReminders 中；省略优先通知提醒。" } },
    required: ["operationId", "target", "scope", "minutes"],
  },
  {
    name: "android_calendar_instance_read", method: "calendar.instance.read",
    description: "复制 query.seriesId/originalStart 读取单次 target。原定时间不随改期改变；editable=false 须在日历应用处理。",
    properties: { seriesId: { type: "string", pattern: "^[0-9]+$" }, originalStart: timestamp },
    required: ["seriesId", "originalStart"],
  },
  { name: "android_calendar_attendees_set", method: "calendar.attendees", description: "复制 read.target，替换所有非组织者参会人；空数组移除。仅在拥有管理权限时执行，已有单次例外不变。同步日历可能发送邀请；写入记录不等于邀请送达。", properties: { operationId, target, scope, attendees: { type: "array", items: attendeeSchema, maxItems: 100 } }, required: ["operationId", "target", "scope", "attendees"] },
  {
    name: "android_calendar_instance_update", method: "calendar.instance.update",
    description: "复制 instance_read.target，只改这一次；须 editable=true（系列已同步、未取消）。不改全天类型。unknown 先查，不换操作号重试。",
    properties: { operationId, target: instanceTarget, patch: { type: "object", properties: patchFields, minProperties: 1, additionalProperties: false } },
    required: ["operationId", "target", "patch"],
  },
  {
    name: "android_calendar_instance_cancel", method: "calendar.instance.cancel",
    description: "复制 instance_read.target，只取消这一次，须 editable=true。重试沿用编号/参数；unknown 先查，恢复交由日历应用。",
    properties: { operationId, target: instanceTarget }, required: ["operationId", "target"],
  },
  {
    name: "android_calendar_recovery_read",
    method: "calendar.recovery",
    description:
      "读变更前字段/提醒；不重建或发送邀请。",
    properties: { recoveryId: operationId },
    required: ["recoveryId"],
  },
];
