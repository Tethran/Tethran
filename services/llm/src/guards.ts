// Input guards for the Settlement Agent (docs/03 section 6, layer 2). They run BEFORE the model is called.
//
//  - injection detection: deterministic patterns, each with a code and the matched snippet (short, redacted);
//  - redaction of personal and payment data, keeping listed payee ids;
//  - size limits (truncate with a visible note);
//  - untrusted-content delimiting with a random per-call boundary token.
//
// Guards never block silently and never make the agent less careful. Findings go to the model as data, are added
// to the result as flags, and force needs_human (see agent.ts). Each step is recorded as a guardrail span in the
// current trace. Spans carry codes, counts and short redacted snippets, never full texts.
import { randomBytes } from "node:crypto";
import type { AgentInput } from "./agent.js";
import { redact } from "./redact.js";
import { currentRun } from "./tracing.js";

export interface Finding {
  code: string;
  /** "contract", "evidence:<id>" or "paid_data:<tool>". */
  source: string;
  /** The matched text with a little context, redacted and truncated. */
  snippet: string;
}

export const LIMITS = {
  contractChars: 8000,
  evidenceItemChars: 4000,
  evidenceTotalChars: 16000,
  evidenceItems: 20,
  paidDataChars: 4000,
  snippetChars: 120,
  maxFindings: 25,
} as const;

// ---------- injection detection ----------

interface Pattern {
  code: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  // instructions to ignore, override or bypass rules
  {
    code: "IGNORE_RULES",
    re: /\b(?:ignore|disregard|forget|override|bypass|circumvent|overrule)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|every|the|your|these|those)\b[^.\n]{0,30}\b(?:rules?|instructions?|policy|policies|limits?|caps?|guidelines|constraints|prompts?|checks?|safeguards?)\b/i,
  },
  { code: "IGNORE_RULES", re: /\b(?:do not|don'?t|never)\s+(?:flag|escalate|report|mention|check|verify)\b/i },
  { code: "IGNORE_RULES", re: /\b(?:approve|release|pay)\b[^.\n]{0,20}\b(?:immediately|automatically|without (?:any )?(?:human )?(?:review|approval|checks?))\b/i },
  // role-play as system, developer or admin; chat-template markers
  { code: "ROLE_PLAY", re: /(?:^|\n)\s*[[<#*]*\s*(?:system|developer|admin(?:istrator)?|assistant)\s*[\]>*]*\s*(?::|override\b|message\b|prompt\b|note\b)/i },
  { code: "ROLE_PLAY", re: /\byou are (?:now|no longer)\b|\bact as (?:the |an? )?(?:system|admin|developer|settlement|operator)|\bpretend (?:to be|you are)\b|\bfrom now on\b/i },
  { code: "ROLE_PLAY", re: /<\|\s*(?:im_start|im_end|system|user|assistant)\s*\|>|\[\/?INST\]|<<\s*SYS\s*>>/i },
  { code: "ROLE_PLAY", re: /\bnew (?:system )?(?:instructions?|rules?|prompt)\b/i },
  // requests to pay someone who is not in the list (listed ids are checked in code, see detectInjection)
  { code: "PAY_UNLISTED_ADDRESS", re: /\b(?:pay|send|transfer|wire|route|redirect|release|forward)\b[^.\n]{0,60}\b0x[0-9a-fA-F]{40}\b/i },
  // requests for keys, secrets, tools, signatures or the prompt
  { code: "KEY_REQUEST", re: /\b(?:private key|seed phrase|recovery phrase|mnemonic|secret key|signing key|passphrase|api[ _-]?key|keystore)\b/i },
  { code: "TOOL_REQUEST", re: /\b(?:submit_cosigned_tx|propose_settlement|buy_corridor_rules|buy_fx_quote)\b|\b(?:call|invoke|execute)\b[^.\n]{0,30}\b(?:tool|function|api)\b|\b(?:sign|broadcast)\s+(?:this|the|a)\s+(?:tx|transaction)\b/i },
  { code: "REVEAL_PROMPT", re: /\b(?:reveal|show|print|repeat|leak|disclose)\b[^.\n]{0,30}\b(?:system prompt|your prompt|your instructions|hidden (?:prompt|instructions))\b/i },
  // attempts to dictate the output
  { code: "FORCE_OUTPUT", re: /\bneeds_human\s*["']?\s*[:=]|\b(?:set|mark|make)\b[^.\n]{0,20}\b(?:needs_human|confidence)\b|\brespond\b[^.\n]{0,20}\bonly with\b/i },
];

const HIDDEN_CHARS = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/;
const HIDDEN_CHARS_G = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/;

function snippetAround(text: string, index: number, len: number): string {
  const start = Math.max(0, index - 20);
  const raw = text.slice(start, Math.min(text.length, index + len + 40)).replace(/\s+/g, " ").trim();
  const red = redact(raw);
  return red.length > LIMITS.snippetChars ? `${red.slice(0, LIMITS.snippetChars)}...` : red;
}

function tryDecodeBase64(blob: string): string | undefined {
  try {
    const dec = Buffer.from(blob, "base64").toString("utf8");
    if (dec.length < 16) return undefined;
    const printable = [...dec].filter((c) => /[\x20-\x7e\n\t]/.test(c)).length;
    return printable / dec.length >= 0.9 ? dec : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds suspicious patterns in untrusted text. `listedPayeeIds` are the ids that may be mentioned; a payee_ id that is
 * not in the list is reported as UNLISTED_PAYEE_REFERENCE. At most one finding per code and source.
 */
export function detectInjection(text: string, source: string, listedPayeeIds: string[] = []): Finding[] {
  const found = new Map<string, Finding>();
  const add = (code: string, index: number, len: number, hay: string, src = source) => {
    const k = `${code}|${src}`;
    if (!found.has(k)) found.set(k, { code, source: src, snippet: snippetAround(hay, index, len) });
  };
  const norm = text.normalize("NFKC");

  const hid = HIDDEN_CHARS.exec(norm);
  if (hid) add("HIDDEN_TEXT", hid.index, 1, norm.replace(HIDDEN_CHARS_G, "?"));
  const cm = HTML_COMMENT.exec(norm);
  if (cm) add("HIDDEN_TEXT", cm.index, cm[0].length, norm);

  const visible = norm.replace(HIDDEN_CHARS_G, "");
  for (const p of PATTERNS) {
    const m = p.re.exec(visible);
    if (m) add(p.code, m.index, m[0].length, visible);
  }

  const listed = new Set(listedPayeeIds.map((i) => i.toLowerCase()));
  for (const m of visible.matchAll(/\bpayee_[a-z0-9_]+\b/gi)) {
    if (!listed.has(m[0].toLowerCase())) {
      add("UNLISTED_PAYEE_REFERENCE", m.index ?? 0, m[0].length, visible);
      break;
    }
  }

  // encoded text: a long base64 blob that decodes to readable text; scan the decoded text too
  for (const m of visible.matchAll(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g)) {
    if (/^[0-9a-fA-F]+$/.test(m[0])) continue; // hashes
    const dec = tryDecodeBase64(m[0]);
    if (dec === undefined) continue;
    add("ENCODED_TEXT", m.index ?? 0, Math.min(m[0].length, 40), visible);
    for (const f of detectInjection(dec, `${source} (decoded)`, listedPayeeIds)) {
      found.set(`${f.code}|${f.source}`, f);
    }
    break;
  }
  return [...found.values()];
}

// ---------- size limits ----------

export interface Truncation {
  source: string;
  removedChars: number;
}

export function limitSize(text: string, max: number, source: string): { text: string; truncation?: Truncation } {
  if (text.length <= max) return { text };
  const removed = text.length - max;
  return { text: `${text.slice(0, max)}\n[TRUNCATED: ${removed} characters removed]`, truncation: { source, removedChars: removed } };
}

// ---------- delimiting ----------

/** A fresh random token for one call. Text inside a block cannot know it. */
export function makeBoundary(): string {
  return randomBytes(9).toString("hex");
}

/** Removes the boundary token and anything shaped like a delimiter from untrusted text. */
export function stripDelimiters(text: string, token: string): string {
  let out = text.split(token).join("");
  out = out.replace(/<<<|>>>/g, "[delim]").replace(/UNTRUSTED_[A-Z_]+#[0-9a-fA-F]*/g, "[delim]");
  return out;
}

export function delimit(label: string, token: string, body: string): string {
  return `<<<${label}#${token}\n${body}\n${label}#${token}>>>`;
}

// ---------- the whole input guard ----------

export interface GuardedInput {
  boundary: string;
  contract: string; // redacted, size-limited, delimiter-free
  evidence: { id: string; text: string }[];
  paidData?: string;
  findings: Finding[];
  truncations: Truncation[];
  redactions: number; // count of placeholders inserted
}

const PLACEHOLDER = /\[(?:EMAIL|PHONE|NUMBER|CARD|IBAN|ADDRESS)\]/g;
const countPlaceholders = (s: string) => (s.match(PLACEHOLDER) ?? []).length;

export function guardInput(input: AgentInput, opts: { boundary?: string } = {}): GuardedInput {
  const boundary = opts.boundary ?? makeBoundary();
  const listed = input.payees.map((p) => p.id);
  const run = currentRun();
  const findings: Finding[] = [];
  const truncations: Truncation[] = [];
  let redactions = 0;

  const clean = (raw: string, max: number, source: string): string => {
    findings.push(...detectInjection(raw, source, listed));
    const sized = limitSize(raw, max, source);
    if (sized.truncation) truncations.push(sized.truncation);
    const red = redact(sized.text, { keep: listed });
    redactions += countPlaceholders(red) - countPlaceholders(sized.text);
    return stripDelimiters(red, boundary);
  };

  const contract = clean(input.contract_text, LIMITS.contractChars, "contract");

  let budget = LIMITS.evidenceTotalChars;
  const evidence: { id: string; text: string }[] = [];
  input.evidence.forEach((e, i) => {
    if (i >= LIMITS.evidenceItems) {
      if (i === LIMITS.evidenceItems) truncations.push({ source: "evidence", removedChars: input.evidence.slice(i).reduce((n, x) => n + x.text.length, 0) });
      return;
    }
    const cap = Math.max(0, Math.min(LIMITS.evidenceItemChars, budget));
    const text = clean(e.text, cap, `evidence:${e.id}`);
    budget -= Math.min(e.text.length, cap);
    evidence.push({ id: stripDelimiters(e.id, boundary).slice(0, 80), text });
  });

  let paidData: string | undefined;
  if (input.paid_data && input.paid_data.length > 0) {
    const parts = input.paid_data.map((d) => {
      // Only the purchased data is untrusted and scanned. The tool label is ours; scanning it would flag every
      // purchase as a tool request.
      const data = clean(JSON.stringify(d.data ?? null), LIMITS.paidDataChars, `paid_data:${d.tool}`);
      return `{"tool":${JSON.stringify(d.tool)},"simulated":${d.simulated === true},"data":${data}}`;
    });
    paidData = parts.join("\n");
  }

  const capped = findings.slice(0, LIMITS.maxFindings);

  run?.span({
    name: "guard.injection_scan",
    type: "guardrail",
    input: { sources: 1 + input.evidence.length + (input.paid_data?.length ?? 0) },
    output: { findings: capped.length, codes: [...new Set(capped.map((f) => f.code))] },
    metadata: { snippets: capped.map((f) => ({ code: f.code, source: f.source, snippet: f.snippet })) },
  });
  run?.span({ name: "guard.redaction", type: "guardrail", output: { placeholders_inserted: redactions } });
  run?.span({
    name: "guard.size_limits",
    type: "guardrail",
    output: { truncated: truncations.length },
    metadata: { truncations, limits: LIMITS },
  });
  run?.span({ name: "guard.delimiting", type: "guardrail", output: { boundary_token_length: boundary.length, blocks: 2 + (paidData ? 1 : 0) } });

  return { boundary, contract, evidence, paidData, findings: capped, truncations, redactions };
}
