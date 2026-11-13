// Delivery evidence (v0.12): uploads with limits and an allowlist, safe downloads, what the agent sees, and the
// agent's delivery check (live answer completed per criterion; replay templates for the three scenarios).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApiError } from "../src/errors";
import { createEvidenceStore, MAX_FILE_BYTES, splitCriteria } from "../src/evidence";
import { withDeliveryCheck } from "../src/orchestrator";
import { instantiate, loadSavedProposals } from "../src/replay";

function store() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, milestone_id TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL)");
  return { db, s: createEvidenceStore(db, mkdtempSync(join(tmpdir(), "tethran-ev-"))) };
}
const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const PDF = Buffer.from("%PDF-1.4\n%fake\n");
const now = new Date("2026-11-13T10:00:00Z");
const code = (c: string) => (e: unknown) => e instanceof ApiError && e.code === c;

test("a submission keeps the note, the link and the files with name, size, type and sha256", () => {
  const { s } = store();
  const id = s.submit("M1", { text: "All five pages delivered.", link: "https://drive.example.com/folder", files: [
    { name: "pages.md", mime: "text/markdown", content_base64: b64("# Home\n# About") },
    { name: "cover.png", mime: "image/png", content_base64: b64(PNG) },
  ] }, now);
  const [e] = s.list("M1");
  assert.equal(e.id, id);
  assert.equal(e.text, "All five pages delivered.");
  assert.equal(e.link, "https://drive.example.com/folder");
  assert.deepEqual(e.files.map((f: any) => [f.name, f.mime, f.size, f.sha256.length, f.download.startsWith("/evidence/files/")]),
    [["pages.md", "text/markdown", 14, 64, true], ["cover.png", "image/png", 24, 64, true]]);
});

test("limits: at most 5 files, 10 MB each, allowlisted types whose content matches; http(s) links; not empty", () => {
  const { s } = store();
  const txt = (n: number) => ({ name: `f${n}.txt`, content_base64: b64("x") });
  assert.throws(() => s.submit("M1", { files: [1, 2, 3, 4, 5, 6].map(txt) }, now), code("TOO_MANY_FILES"));
  assert.throws(() => s.submit("M1", { files: [{ name: "big.txt", content_base64: Buffer.alloc(MAX_FILE_BYTES + 1, 0x61).toString("base64") }] }, now), code("FILE_TOO_LARGE"));
  for (const name of ["run.exe", "page.html", "script.js", "noext", "image.svg"]) {
    assert.throws(() => s.submit("M1", { files: [{ name, content_base64: b64("x") }] }, now), code("FILE_TYPE_NOT_ALLOWED"), name);
  }
  assert.throws(() => s.submit("M1", { files: [{ name: "fake.png", content_base64: b64("<script>") }] }, now), code("FILE_TYPE_MISMATCH"));
  assert.throws(() => s.submit("M1", { files: [{ name: "a.pdf", mime: "image/png", content_base64: b64(PDF) }] }, now), code("FILE_TYPE_MISMATCH"));
  assert.throws(() => s.submit("M1", { files: [{ name: "bin.txt", content_base64: b64(Buffer.from([0x61, 0, 0x62])) }] }, now), code("FILE_TYPE_MISMATCH"));
  assert.throws(() => s.submit("M1", { link: "javascript:alert(1)" }, now), code("BAD_LINK"));
  assert.throws(() => s.submit("M1", { link: "file:///etc/passwd" }, now), code("BAD_LINK"));
  assert.throws(() => s.submit("M1", { text: "  " }, now), code("EMPTY_SUBMISSION"));
  assert.equal(s.list("M1").length, 0, "nothing stored from a refused submission");
});

test("downloads are attachments, never rendered or executed; the stored name cannot reach the disk path", () => {
  const { s } = store();
  s.submit("M1", { files: [{ name: "../../evil name\".txt", content_base64: b64("hello") }] }, now);
  const f = s.list("M1")[0].files[0];
  assert.equal(f.name, "evil name_.txt", "path parts and quotes removed");
  const d = s.download(String(f.id));
  assert.equal(d.contentType, "application/octet-stream");
  assert.match(d.headers["content-disposition"], /^attachment; filename="evil name_.txt"/);
  assert.equal(d.headers["x-content-type-options"], "nosniff");
  assert.match(d.headers["content-security-policy"], /sandbox/);
  assert.equal(d.body.toString(), "hello");
  assert.throws(() => s.download("../1"), (e: unknown) => e instanceof ApiError && e.status === 404);
  assert.throws(() => s.download("999"), (e: unknown) => e instanceof ApiError && e.status === 404);
});

test("the agent sees the note, the link and text-like files; other files only as metadata, 'not inspected'", () => {
  const { s } = store();
  s.submit("M1", { text: "Report attached.", link: "https://example.com/r", files: [
    { name: "table.csv", content_base64: b64("competitor,price\nA,10") },
    { name: "report.pdf", content_base64: b64(PDF) },
  ] }, now);
  const [item] = s.forAgent("M1");
  assert.match(item.id, /^ev-\d+$/);
  assert.match(item.text, /Delivery note: Report attached\./);
  assert.match(item.text, /Link: https:\/\/example\.com\/r/);
  assert.match(item.text, /File table\.csv \(text\/csv, 21 bytes, sha256 [0-9a-f]{64}\), content:\ncompetitor,price\nA,10/);
  assert.match(item.text, /File report\.pdf \(application\/pdf, \d+ bytes, sha256 [0-9a-f]{64}\): not inspected/);
  assert.ok(!item.text.includes("%PDF"), "a pdf's bytes are never passed");
});

test("criteria: one per line or per ';', bullets and numbering removed", () => {
  assert.deepEqual(splitCriteria("Five page texts delivered; Proofread by an editor"), ["Five page texts delivered", "Proofread by an editor"]);
  assert.deepEqual(splitCriteria("- Twenty photos\n2. PNG files\n\n"), ["Twenty photos", "PNG files"]);
  assert.deepEqual(splitCriteria("Three concepts, one refined"), ["Three concepts, one refined"]);
  assert.deepEqual(splitCriteria(""), []);
});

test("the plan's check covers every criterion: kept when given, 'unclear' when the agent skipped one", () => {
  const p = withDeliveryCheck({ delivery_check: [{ criterion: "proofread by an EDITOR", status: "met" as const, reason: "edit log" }] }, ["Five pages", "Proofread by an editor"]);
  assert.deepEqual(p.delivery_check!.map((c) => [c.criterion, c.status]), [["Five pages", "unclear"], ["Proofread by an editor", "met"]]);
  assert.deepEqual(withDeliveryCheck({}, []), {});
});

test("replay: the three delivery-check scenarios expand to the milestone's own criteria", () => {
  const saved = loadSavedProposals();
  const input = (criteria: string[]) => ({ milestone: { id: "M1", gross_amount: "50000000" }, criteria, platform_fee: { payee_id: "tethran_earnings", amount: "2500000" } }) as any;
  const status = (scenario: string, criteria: string[]) => (instantiate(saved.get(scenario)!, input(criteria)) as any).delivery_check.map((c: any) => c.status);
  assert.deepEqual(status("criteria_met", ["Five page texts delivered", "Proofread by an editor"]), ["met", "met"]);
  assert.deepEqual(status("criteria_unmet", ["Twenty edited photos", "Delivered as PNG files"]), ["unmet", "met"]);
  assert.deepEqual(status("criteria_silent", ["Ten-page report", "Includes a competitor table"]), ["unclear", "unclear"]);
  assert.deepEqual(status("clean_delivery", ["Brand pack: delivered as agreed"]), ["met"]);
  // A milestone without criteria gets no check at all (nothing to escalate on).
  assert.equal((instantiate(saved.get("criteria_met")!, input([])) as any).delivery_check, undefined);
});
