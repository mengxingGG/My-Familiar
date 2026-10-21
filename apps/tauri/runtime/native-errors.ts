/** 原生桥只传递可处理的固定错误码，不转发异常正文或系统路径。 */
export function nativeError(code: unknown): Error {
  return new Error(
    typeof code === "string" &&
      ["CONFLICT", "INVALID_INPUT", "NOT_FOUND", "UNAVAILABLE"].includes(code)
      ? code
      : "UNAVAILABLE",
  );
}
