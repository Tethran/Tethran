// Delivery evidence (v0.12): a note, a link and up to 5 files per submission, and the agent's delivery check.
//
// Files: JSON upload with base64 content (no multipart parser, no new dependency). Up to MAX_FILES files of at most
// MAX_FILE_BYTES each; only the allowlisted types, and the extension, the declared type and the file's own signature
// must agree. Stored on the backend's data disk under their sha256 (content-addressed; the original name is never a
// path), so nothing a user uploads is ever executed or served from its own name. Downloads are attachments with
// nosniff and a sandboxing CSP.
//
// Untrusted: the note, the link, every file and the criteria text. They reach the agent only as delimited data.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ApiError } from "./errors";

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_NOTE_CHARS = 20_000;
/** Text taken from one text-like file for the agent. */
export const MAX_EXTRACT_CHARS = 20_000;
/** JSON body limit for a submission: 5 files of 10 MB in base64, plus the note. */
export const MAX_EVIDENCE_BODY = Math.ceil((MAX_FILES * MAX_FILE_BYTES * 4) / 3) + 512 * 1024;

type Kind = { mime: string; text: boolean; magic?: (b: Buffer) => boolean };
const starts = (sig: number[]) => (b: Buffer) => sig.every((x, i) => b[i] === x);
/** The allowlist: extension -> type. Text-like types are read as text for the agent; the rest are never opened. */
export const ALLOWED: Record<string, Kind> = {
  txt: { mime: "text/plain", text: true },
  md: { mime: "text/markdown", text: true },
  csv: { mime: "text/csv", text: true },
  json: { mime: "application/json", text: true },
  pdf: { mime: "application/pdf", text: false, magic: starts([0x25, 0x50, 0x44, 0x46]) },
  png: { mime: "image/png", text: false, magic: starts([0x89, 0x50, 0x4e, 0x47]) },
  jpg: { mime: "image/jpeg", text: false, magic: starts([0xff, 0xd8, 0xff]) },
  jpeg: { mime: "image/jpeg", text: false, magic: starts([0xff, 0xd8, 0xff]) },
  gif: { mime: "image/gif", text: false, magic: starts([0x47, 0x49, 0x46, 0x38]) },
  webp: { mime: "image/webp", text: false, magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  zip: { mime: "application/zip", text: false, magic: starts([0x50, 0x4b, 0x03, 0x04]) },
};

export function migrateEvidence(db: DatabaseSync) {
  const cols = (db.prepare("PRAGMA table_info(evidence)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("link")) db.exec("ALTER TABLE evidence ADD COLUMN link TEXT");
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT, evidence_id INTEGER NOT NULL, milestone_id TEXT NOT NULL,
      name TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, sha256 TEXT NOT NULL, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS evidence_files_milestone ON evidence_files (milestone_id);
    -- The agent's delivery check: advisory at submission, the latest one is shown to the client at approval time.
    CREATE TABLE IF NOT EXISTS delivery_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT NOT NULL, evidence_id INTEGER, checks_json TEXT NOT NULL,
      agent_mode TEXT NOT NULL, error TEXT, at TEXT NOT NULL
    );
  `);
}

/** One criterion per line or per ";" of the milestone's "Done when…" text (bullets and numbering removed). */
export function splitCriteria(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.split(/\r?\n|;/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter((s) => s.length > 0).slice(0, 20);
}

/** The milestone's acceptance criteria: the contract milestone with the same id (escrow id = contract milestone id). */
export function criteriaOf(db: DatabaseSync, milestoneId: string): string[] {
  try {
    const r = db.prepare("SELECT acceptance_criteria FROM contract_milestones WHERE id = ?").get(milestoneId) as { acceptance_criteria: string } | undefined;
    return splitCriteria(r?.acceptance_criteria);
  } catch {
    return [];
  }
}

function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = base.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return clean.length > 0 ? clean : "file";
}

export interface UploadInput { name?: unknown; mime?: unknown; content_base64?: unknown }

export function createEvidenceStore(db: DatabaseSync, uploadsDir?: string) {
  migrateEvidence(db);
  const dir = uploadsDir ?? join(tmpdir(), "tethran-uploads");
  mkdirSync(dir, { recursive: true });

  function checkFile(f: UploadInput, i: number) {
    if (typeof f?.name !== "string" || f.name.length === 0) throw new ApiError(400, `file ${i + 1}: name is required`, "BAD_FILE");
    const name = safeName(f.name);
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const kind = ALLOWED[ext];
    if (!kind) throw new ApiError(400, `file ${i + 1}: type .${ext || "?"} is not allowed (allowed: ${Object.keys(ALLOWED).join(", ")})`, "FILE_TYPE_NOT_ALLOWED");
    if (typeof f.mime === "string" && f.mime.length > 0 && f.mime.split(";")[0].trim().toLowerCase() !== kind.mime) {
      throw new ApiError(400, `file ${i + 1}: declared type ${f.mime} does not match .${ext}`, "FILE_TYPE_MISMATCH");
    }
    if (typeof f.content_base64 !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(f.content_base64)) throw new ApiError(400, `file ${i + 1}: content_base64 is required`, "BAD_FILE");
    const bytes = Buffer.from(f.content_base64, "base64");
    if (bytes.length === 0) throw new ApiError(400, `file ${i + 1} is empty`, "BAD_FILE");
    if (bytes.length > MAX_FILE_BYTES) throw new ApiError(413, `file ${i + 1} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`, "FILE_TOO_LARGE");
    if (kind.magic && !kind.magic(bytes)) throw new ApiError(400, `file ${i + 1}: content is not a .${ext} file`, "FILE_TYPE_MISMATCH");
    if (kind.text && bytes.includes(0)) throw new ApiError(400, `file ${i + 1}: a .${ext} file must be text`, "FILE_TYPE_MISMATCH");
    return { name, mime: kind.mime, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  return {
    /** Stores a submission. At least one of note, link or files. Returns the evidence id. */
    submit(milestoneId: string, body: { text?: unknown; link?: unknown; files?: unknown }, now: Date) {
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (text.length > MAX_NOTE_CHARS) throw new ApiError(400, `the note is longer than ${MAX_NOTE_CHARS} characters`, "BAD_NOTE");
      let link: string | null = null;
      if (body?.link !== undefined && body.link !== null && body.link !== "") {
        if (typeof body.link !== "string" || body.link.length > 2000) throw new ApiError(400, "link must be a URL of at most 2000 characters", "BAD_LINK");
        let u: URL;
        try { u = new URL(body.link); } catch { throw new ApiError(400, "link is not a valid URL", "BAD_LINK"); }
        if (u.protocol !== "https:" && u.protocol !== "http:") throw new ApiError(400, "link must be http or https", "BAD_LINK");
        link = u.toString();
      }
      const raw = body?.files === undefined ? [] : body.files;
      if (!Array.isArray(raw)) throw new ApiError(400, "files must be an array", "BAD_FILE");
      if (raw.length > MAX_FILES) throw new ApiError(400, `at most ${MAX_FILES} files per submission`, "TOO_MANY_FILES");
      const files = (raw as UploadInput[]).map(checkFile);
      if (!text && !link && files.length === 0) throw new ApiError(400, "add a note, a link or a file", "EMPTY_SUBMISSION");
      const at = now.toISOString();
      for (const f of files) {
        const p = join(dir, f.sha256);
        if (!existsSync(p)) writeFileSync(p, f.bytes, { mode: 0o600 });
      }
      // The note column is NOT NULL in older databases: an empty note is stored as "".
      const id = Number(db.prepare("INSERT INTO evidence (milestone_id, text, link, at) VALUES (?, ?, ?, ?)").run(milestoneId, text, link, at).lastInsertRowid);
      const ins = db.prepare("INSERT INTO evidence_files (evidence_id, milestone_id, name, size, mime, sha256, at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const f of files) ins.run(id, milestoneId, f.name, f.bytes.length, f.mime, f.sha256, at);
      return id;
    },

    /** Everything submitted for a milestone, oldest first, with the actual note, link and file metadata. */
    list(milestoneId: string) {
      const rows = db.prepare("SELECT id, text, link, at FROM evidence WHERE milestone_id = ? ORDER BY id").all(milestoneId) as { id: number; text: string; link: string | null; at: string }[];
      const files = db.prepare("SELECT id, evidence_id, name, size, mime, sha256 FROM evidence_files WHERE milestone_id = ? ORDER BY id").all(milestoneId) as any[];
      return rows.map((r) => ({ id: r.id, text: r.text, link: r.link ?? null, at: r.at, files: files.filter((f) => f.evidence_id === r.id).map(({ evidence_id: _e, ...f }) => ({ ...f, download: `/evidence/files/${f.id}` })) }));
    },

    /**
     * The evidence as the agent sees it (untrusted data): one item per submission with the note, the link, the text of
     * text-like files (up to MAX_EXTRACT_CHARS each) and, for every other file, its name, type, size and hash only,
     * marked "not inspected".
     */
    forAgent(milestoneId: string): { id: string; text: string }[] {
      return this.list(milestoneId).map((e) => {
        const parts: string[] = [];
        if (e.text) parts.push(`Delivery note: ${e.text}`);
        if (e.link) parts.push(`Link: ${e.link}`);
        for (const f of e.files) {
          const head = `File ${f.name} (${f.mime}, ${f.size} bytes, sha256 ${f.sha256})`;
          const kind = Object.values(ALLOWED).find((k) => k.mime === f.mime);
          if (kind?.text) {
            let content = "";
            try { content = readFileSync(join(dir, f.sha256), "utf8").slice(0, MAX_EXTRACT_CHARS); } catch { content = "[file missing on the server]"; }
            parts.push(`${head}, content:\n${content}`);
          } else {
            parts.push(`${head}: not inspected (only its name, type, size and hash are known)`);
          }
        }
        return { id: `ev-${e.id}`, text: parts.join("\n") };
      });
    },

    /** A download: always an attachment, never rendered by the browser, never executed. */
    download(fileId: string) {
      if (!/^\d+$/.test(fileId)) throw new ApiError(404, "file not found");
      const f = db.prepare("SELECT * FROM evidence_files WHERE id = ?").get(Number(fileId)) as any;
      if (!f) throw new ApiError(404, "file not found");
      let body: Buffer;
      try { body = readFileSync(join(dir, f.sha256)); } catch { throw new ApiError(404, "file not found"); }
      const ascii = String(f.name).replace(/[^A-Za-z0-9._ -]/g, "_");
      return {
        __raw: true as const,
        contentType: "application/octet-stream",
        body,
        headers: {
          "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "no-store",
        },
      };
    },

    saveCheck(milestoneId: string, evidenceId: number | null, checks: unknown[], agentMode: string, error: string | null, now: Date) {
      db.prepare("INSERT INTO delivery_checks (milestone_id, evidence_id, checks_json, agent_mode, error, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(milestoneId, evidenceId, JSON.stringify(checks), agentMode, error, now.toISOString());
    },

    latestCheck(milestoneId: string) {
      const r = db.prepare("SELECT * FROM delivery_checks WHERE milestone_id = ? ORDER BY id DESC LIMIT 1").get(milestoneId) as any;
      return r ? { checks: JSON.parse(r.checks_json), agent_mode: r.agent_mode, error: r.error ?? null, at: r.at, evidence_id: r.evidence_id } : null;
    },
  };
}
export type EvidenceStore = ReturnType<typeof createEvidenceStore>;
