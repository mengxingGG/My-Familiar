import {
  MobileBridgeError,
  type MobileCareState,
} from "../mobile-contracts/index.ts";
import { validateCare } from "../../plugins/companion-care/schedule.ts";
export function projectCareResult(
  method: string,
  value: unknown,
): MobileCareState | undefined {
  if (method === "care.locate.cancel") return;
  const v = value as MobileCareState;
  const fail = () => {
    throw new MobileBridgeError("UNAVAILABLE", "关怀返回内容不兼容");
  };
  if (
    !v ||
    typeof v !== "object" ||
    typeof v.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.revision) ||
    typeof v.busy !== "boolean" ||
    typeof v.locationPermission !== "boolean" ||
    typeof v.locationEnabled !== "boolean"
  )
    return fail();
  let settings;
  try {
    settings = validateCare(v.settings);
  } catch {
    return fail();
  }
  if (
    (v.lastMessage !== undefined &&
      (typeof v.lastMessage !== "string" || v.lastMessage.length > 4000)) ||
    (v.lastError !== undefined &&
      (typeof v.lastError !== "string" || v.lastError.length > 300))
  )
    return fail();
  const l = v.location;
  if (
    l &&
    (!Number.isFinite(l.accuracy) ||
      l.accuracy < 0 ||
      l.accuracy > 10000 ||
      !Number.isFinite(l.time) ||
      typeof l.mock !== "boolean")
  )
    return fail();
  return {
    settings,
    revision: v.revision,
    busy: v.busy,
    locationPermission: v.locationPermission,
    locationEnabled: v.locationEnabled,
    ...(v.lastMessage ? { lastMessage: v.lastMessage } : {}),
    ...(v.lastError ? { lastError: v.lastError } : {}),
    ...(l
      ? { location: { accuracy: l.accuracy, time: l.time, mock: l.mock } }
      : {}),
  };
}
