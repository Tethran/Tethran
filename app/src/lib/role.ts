// The role the person is looking at the app as ("Switch role"): freelancer, client, operator or arbiter. It decides
// whose notifications the bell shows and which Home the dashboard renders. Not a login: a view preference kept in
// this browser (localStorage, guarded) and settable by ?as=<role> in any app URL.
import { useEffect, useState } from "react";

export const ROLES = ["freelancer", "client", "operator", "arbiter"] as const;
export type Role = (typeof ROLES)[number];
const KEY = "tethran.role";
const EVENT = "tethran:role";

const isRole = (v: unknown): v is Role => typeof v === "string" && (ROLES as readonly string[]).includes(v);

export function readRole(): Role {
  try {
    const fromUrl = typeof location !== "undefined" ? new URLSearchParams(location.search).get("as") : null;
    if (isRole(fromUrl)) { localStorage.setItem(KEY, fromUrl); return fromUrl; }
    const stored = localStorage.getItem(KEY);
    if (isRole(stored)) return stored;
  } catch { /* storage blocked: default below */ }
  return "freelancer";
}

export function setRole(r: Role) {
  try { localStorage.setItem(KEY, r); } catch { /* storage blocked: still switch for this page */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: r }));
}

/** The current role; follows setRole() in this tab and storage changes from other tabs. */
export function useRole(): Role {
  const [role, set] = useState<Role>("freelancer");
  useEffect(() => {
    set(readRole());
    const onRole = (e: Event) => { const r = (e as CustomEvent).detail; if (isRole(r)) set(r); };
    const onStorage = () => set(readRole());
    window.addEventListener(EVENT, onRole);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener(EVENT, onRole); window.removeEventListener("storage", onStorage); };
  }, []);
  return role;
}
