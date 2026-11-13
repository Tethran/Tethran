// Cuts the two raw film recordings (client and freelancer) to the exact step lengths in the markers file, on one
// timeline, so the two outputs stay in sync and have the same length. Per step: holds play at normal speed, waits are
// sped up first (down to a short flash), then actions; if a step is still too long, everything in it is sped up
// evenly; if it is too short, its last frame is held. Writes H.264 MP4 at 1920x1080, 30 fps, and the timing of each
// step in the output to e2e-artifacts/film/final-cut-markers.json. Needs ffmpeg on PATH.
//   node e2e/cut-film.mjs [--markers e2e-artifacts/film/final-markers.json] [--crf 20]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const M = JSON.parse(readFileSync(arg("--markers", "e2e-artifacts/film/final-markers.json"), "utf8"));
const CRF = arg("--crf", "20");
const MIN_WAIT = 0.25; // seconds a wait keeps in the cut
const MAX_ACTION_SPEED = 4; // actions are not sped up more than this before holds are touched

/** Splits one step into ordered segments: hold, wait, or action (everything else). */
function segments(step) {
  const marks = [...step.holds.map(([s, e]) => ({ s, e, kind: "hold" })), ...step.waits.map(([s, e]) => ({ s, e, kind: "wait" }))]
    .filter((m) => m.e > m.s).sort((a, b) => a.s - b.s);
  const out = [];
  let t = step.start;
  for (const m of marks) {
    const s = Math.max(m.s, t);
    if (s > t + 0.001) out.push({ s: t, e: s, kind: "action" });
    if (m.e > s) out.push({ s, e: m.e, kind: m.kind });
    t = Math.max(t, m.e);
  }
  if (step.end > t + 0.001) out.push({ s: t, e: step.end, kind: "action" });
  return out.map((x) => ({ ...x, raw: x.e - x.s }));
}

/** Gives each segment an output length so the step lasts exactly `target` seconds; returns the padding needed. */
function plan(segs, target) {
  const sum = (k) => segs.filter((x) => x.kind === k).reduce((n, x) => n + x.raw, 0);
  const H = sum("hold"), A = sum("action"), W = sum("wait");
  const waits = segs.filter((x) => x.kind === "wait");
  for (const x of segs) x.out = x.raw;
  if (H + A + W <= target) return target - (H + A + W); // short: pad
  const minW = waits.reduce((n, x) => n + Math.min(x.raw, MIN_WAIT), 0);
  const roomW = target - H - A;
  if (roomW >= minW) { // only waits shrink: share the room by raw length, but never below the flash
    const scale = (roomW - minW) / Math.max(1e-6, W - minW);
    for (const x of waits) x.out = Math.min(x.raw, MIN_WAIT) + (x.raw - Math.min(x.raw, MIN_WAIT)) * scale;
    return 0;
  }
  for (const x of waits) x.out = Math.min(x.raw, MIN_WAIT);
  const roomA = target - H - minW;
  if (roomA >= A / MAX_ACTION_SPEED) { for (const x of segs) if (x.kind === "action") x.out = x.raw * (roomA / A); return 0; }
  for (const x of segs) if (x.kind === "action") x.out = x.raw / MAX_ACTION_SPEED;
  const roomH = target - minW - A / MAX_ACTION_SPEED;
  if (roomH > 0) { for (const x of segs) if (x.kind === "hold") x.out = x.raw * (roomH / H); return 0; }
  const all = segs.reduce((n, x) => n + x.out, 0); // nothing left: everything evenly
  for (const x of segs) x.out = x.out * (target / all);
  return 0;
}

const order = Object.keys(M.targets);
const steps = order.map((id) => M.steps.find((s) => s.id === id)).filter(Boolean);
if (steps.length !== order.length) console.warn(`only ${steps.length} of ${order.length} steps recorded: ${steps.map((s) => s.id).join(", ")}`);
const planned = steps.map((st) => { const segs = segments(st); const pad = plan(segs, M.targets[st.id]); return { st, segs, pad }; });

mkdirSync("e2e-artifacts/recordings", { recursive: true });
const cutMarkers = [];
{ let t = 0; for (const p of planned) { const d = M.targets[p.st.id]; cutMarkers.push({ id: p.st.id, name: p.st.name, start: +t.toFixed(3), end: +(t + d).toFixed(3) }); t += d; } }
const total = cutMarkers.at(-1)?.end ?? 0;

for (const who of ["client", "freelancer"]) {
  const off = M.videos[who].offset;
  const parts = [];
  let n = 0;
  for (const p of planned) {
    for (const x of p.segs) {
      if (x.out < 1 / 60) continue;
      const speed = x.raw / x.out;
      parts.push(`[0:v]trim=start=${(x.s + off).toFixed(3)}:end=${(x.e + off).toFixed(3)},setpts=(PTS-STARTPTS)/${speed.toFixed(6)},fps=30[s${n}]`);
      n++;
    }
    if (p.pad > 1 / 60) { // hold the step's last frame
      const last = p.segs.at(-1);
      const at = (last ? last.e : p.st.end) + off;
      parts.push(`[0:v]trim=start=${Math.max(0, at - 0.3).toFixed(3)}:end=${at.toFixed(3)},reverse,trim=end_frame=1,setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop_duration=${p.pad.toFixed(3)},trim=duration=${p.pad.toFixed(3)}[s${n}]`);
      n++;
    }
  }
  // Every input pad is a trim of the same source: split it once per use.
  const graph = [`[0:v]split=${n}${Array.from({ length: n }, (_, i) => `[i${i}]`).join("")}`,
    ...parts.map((s, i) => s.replace("[0:v]", `[i${i}]`)),
    `${Array.from({ length: n }, (_, i) => `[s${i}]`).join("")}concat=n=${n}:v=1:a=0,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p,trim=duration=${total.toFixed(3)}[out]`].join(";\n");
  const gfile = `e2e-artifacts/film/${who}-graph.txt`;
  writeFileSync(gfile, graph);
  const out = `e2e-artifacts/recordings/tethran-film-${who}.mp4`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", `e2e-artifacts/film-raw/${who}.webm`, "-/filter_complex", gfile, "-map", "[out]",
    "-c:v", "libx264", "-preset", "medium", "-crf", CRF, "-r", "30", "-movflags", "+faststart", out], { stdio: "inherit" });
  const dur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim());
  console.log(`${who}: ${out} ${dur.toFixed(2)}s ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB`);
}
writeFileSync("e2e-artifacts/film/final-cut-markers.json", JSON.stringify({ viewport: "1920x1080", fps: 30, total, steps: cutMarkers,
  files: { client: "e2e-artifacts/recordings/tethran-film-client.mp4", freelancer: "e2e-artifacts/recordings/tethran-film-freelancer.mp4" } }, null, 2));
console.log(`steps: ${cutMarkers.map((s) => `${s.id} ${s.start}-${s.end}`).join(", ")}; total ${total}s`);
