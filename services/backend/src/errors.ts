/** An error with an HTTP status and a short, safe message (no URLs, keys or stack traces). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export const bad = (msg: string, code?: string): never => {
  throw new ApiError(400, msg, code);
};

/** A short printable message for any thrown value, with URLs removed (an RPC URL can carry an API key). */
export function safeErrorMessage(e: unknown): string {
  const err = e as { shortMessage?: unknown; message?: unknown; code?: unknown };
  const text = typeof err?.shortMessage === "string" ? err.shortMessage
    : typeof err?.message === "string" ? err.message
    : String(e);
  const code = typeof err?.code === "string" ? ` [${err.code}]` : "";
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"',)]+/gi, "[url removed]") + code;
}
