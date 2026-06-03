import { readFileSync } from "fs";

const API = "https://fen6lbzeah.execute-api.ap-southeast-1.amazonaws.com";
const DIR = "../../";

const GROUND_TRUTH = {
  "IMG_5816.jpeg": 31,
  "IMG_5817.jpeg": 34,
  "IMG_5818.jpeg": 4,
  "IMG_5819.jpeg": 15,
  "IMG_5825.jpeg": 22,
  "z7684272505382_c6246306bfd98e30b517ecf83e168fea.jpg": 45,
  "z7684272512641_ad8f1ab954706c9fb0c3f3323e4c9318.jpg": 27,
  "z7684272609303_0427067caf3a7fc990dc1624d92df2da.jpg": 42,
  "z7684272634118_fd6cb398bd8149242fbd967023d2dd7a.jpg": 45,
  "z7706421817056_b9ad273ea1c75c9f3af8df19961ce0b8.jpg": 36,
  "z7706421874606_a5df4ab4329ae93b039b4253f6dabca9.jpg": 30,
  "z7706425611275_f11dff944c8214b8296bb7997b00b70d.jpg": 40,
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runOne(filename) {
  const buf = readFileSync(DIR + filename);
  const mediaType = filename.toLowerCase().endsWith("png") ? "image/png" : "image/jpeg";

  let r = await fetch(`${API}/upload-url`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename, mediaType }),
  });
  const { jobId, key, uploadUrl } = await r.json();

  await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mediaType }, body: buf });
  await fetch(`${API}/process`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, key, filename }),
  });

  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    r = await fetch(`${API}/result/${jobId}`);
    const res = await r.json();
    if (res.status === "done") return { boxCount: res.boxCount, grid: res.grid, holeCount: res.holeCount, lowConfidence: res.lowConfidence, columnCounts: res.columnCounts, processingMs: res.processingMs };
    if (res.status === "error") return { error: res.error };
  }
  return { error: "timeout" };
}

const results = [];
// run all in parallel (independent jobs) — mirrors the frontend's parallel processing
const entries = Object.entries(GROUND_TRUTH);
const wallStart = Date.now();
const settled = await Promise.all(entries.map(async ([f, truth]) => {
  const out = await runOne(f).catch(e => ({ error: String(e.message || e) }));
  return { f, truth, ...out };
}));
const wallSec = ((Date.now() - wallStart) / 1000).toFixed(1);

console.log("\n================ RESULT vs TRUE ================");
let pass = 0, totalDiff = 0;
for (const s of settled) {
  if (s.error) { console.log(`✗ ${s.f}\n    true=${s.truth}  ERROR: ${s.error}`); continue; }
  const diff = s.boxCount - s.truth;
  totalDiff += Math.abs(diff);
  const mark = diff === 0 ? "✓ EXACT" : `Δ ${diff > 0 ? "+" : ""}${diff}`;
  if (diff === 0) pass++;
  const cc = `holes≈${s.holeCount ?? "?"}  cols=[${(s.columnCounts||[]).join(",")}]  ${s.processingMs ? (s.processingMs/1000).toFixed(1)+"s" : ""}${s.lowConfidence ? "  ⚠LOW-CONF" : ""}`;
  console.log(`${diff === 0 ? "✓" : "·"} ${s.f}\n    true=${s.truth}  got=${s.boxCount}  grid=${s.grid}  [${mark}]  ${cc}`);
}
console.log("===============================================");
console.log(`Exact: ${pass}/${settled.length} | total abs error: ${totalDiff} | wall-clock (all parallel): ${wallSec}s`);
