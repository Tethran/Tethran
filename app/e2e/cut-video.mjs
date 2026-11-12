// Builds e2e-artifacts/recordings/tethran-demo-short.webm from the short demo's raw recording: every wait the spec
// recorded (e2e-artifacts/demo-short-marks.json) is sped up to about one second; everything else plays at normal
// speed. Nothing that is not a wait is removed. Needs ffmpeg on PATH.
//   node e2e/cut-video.mjs [raw.webm]   (default: the newest .webm under e2e-artifacts/demo-short/)
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const WAIT_SECONDS = 1.0; // a wait plays this long in the cut
const MIN_WAIT = 1.5; // shorter waits play at normal speed

function newestWebm(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); statSync(p).isDirectory() ? walk(p) : p.endsWith(".webm") && out.push(p); } };
  walk(dir);
  if (!out.length) throw new Error(`no .webm under ${dir}`);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const raw = process.argv[2] ?? newestWebm("e2e-artifacts/demo-short");
const { waits } = JSON.parse(readFileSync("e2e-artifacts/demo-short-marks.json", "utf8"));
const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", raw]).toString().trim());

// Segments over the whole video: [start, end, speed].
const segs = [];
let at = 0;
for (const [s0, e0] of waits.map(([a, b]) => [Math.max(0, a), Math.min(duration, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
  const s = Math.max(s0, at);
  if (s > at) segs.push([at, s, 1]);
  if (e0 - s >= MIN_WAIT) segs.push([s, e0, (e0 - s) / WAIT_SECONDS]);
  else if (e0 > s) segs.push([s, e0, 1]);
  at = Math.max(at, e0);
}
if (duration > at) segs.push([at, duration, 1]);

const parts = segs.map(([s, e, k], i) => `[v${i}]trim=start=${s.toFixed(3)}:end=${e.toFixed(3)},setpts=(PTS-STARTPTS)/${k.toFixed(4)}[o${i}]`);
const filter = `[0:v]split=${segs.length}${segs.map((_, i) => `[v${i}]`).join("")};${parts.join(";")};${segs.map((_, i) => `[o${i}]`).join("")}concat=n=${segs.length}:v=1:a=0,fps=25[out]`;
mkdirSync("e2e-artifacts/recordings", { recursive: true });
const out = "e2e-artifacts/recordings/tethran-demo-short.webm";
execFileSync("ffmpeg", ["-y", "-v", "error", "-i", raw, "-filter_complex", filter, "-map", "[out]", "-c:v", "libvpx-vp9", "-b:v", "2500k", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", out], { stdio: "inherit" });
const final = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim());
const waited = segs.filter(([, , k]) => k > 1).reduce((n, [s, e]) => n + (e - s), 0);
console.log(`raw ${duration.toFixed(1)}s, ${waits.length} waits (${waited.toFixed(1)}s sped up) -> ${out}: ${final.toFixed(1)}s (${Math.floor(final / 60)}m${String(Math.round(final % 60)).padStart(2, "0")}s)`);
