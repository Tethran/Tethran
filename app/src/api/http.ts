// The one place the app talks to the Tethran backend (docs/API.md). No keys, no secrets in the browser.
// The base URL defaults to the demo backend started by `npm run demo` (port 18788); set VITE_TETHRAN_API_URL in the
// shell to point elsewhere. No env file is needed or committed.

export const API_BASE: string =
  (import.meta.env?.["VITE_TETHRAN_API_URL"] as string | undefined) ?? "http://127.0.0.1:18788";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0) {
    super(message);
  }
}

export async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("UNREACHABLE", "The Tethran server can't be reached. Is `npm run demo` running?");
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    throw new ApiError(json?.code ?? `HTTP_${res.status}`, json?.error ?? `The server answered ${res.status}.`, res.status);
  }
  return json as T;
}

export const get = <T,>(path: string) => request<T>("GET", path);
export const post = <T,>(path: string, body: unknown = {}) => request<T>("POST", path, body);

/** Base units of test USDT (six decimals, a string) to dollars, for display only. */
export function dollars(baseUnits: string | number | null | undefined): number {
  if (baseUnits === null || baseUnits === undefined || baseUnits === "") return 0;
  const v = BigInt(String(baseUnits));
  return Number(v / 10_000n) / 100; // whole cents, so display never shows float noise
}
export const centsToDollars = (cents: number) => cents / 100;
