export interface MobileStartup {
  /** 应用偏好；不代表设备厂商的自启动权限已允许。 */
  enabled: boolean;
  overlayGranted: boolean;
  lastResult: "none" | "requested" | "started" | "permission" | "restricted" | "cancelled" | "failed";
  lastAttemptAt: number;
  detail: string;
}
