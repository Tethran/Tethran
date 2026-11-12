/**
 * A short, printable message for any thrown value, with URLs removed.
 * RPC URLs can carry an API key, and ethers puts the request URL into its error objects,
 * so scripts and services print this instead of the raw error.
 */
export function safeErrorMessage(e: unknown): string {
  const err = e as { shortMessage?: unknown; message?: unknown; code?: unknown };
  const text = typeof err?.shortMessage === "string" ? err.shortMessage
    : typeof err?.message === "string" ? err.message
    : String(e);
  const code = typeof err?.code === "string" ? ` [${err.code}]` : "";
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"',)]+/gi, "[url removed]") + code;
}
