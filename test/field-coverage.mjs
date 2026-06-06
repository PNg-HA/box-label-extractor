import { readFileSync } from "fs";

const API = "https://fen6lbzeah.execute-api.ap-southeast-1.amazonaws.com";
const DIR = "../../";

const GROUND_TRUTH = {
  "IMG_5816.jpeg": 31, "IMG_5817.jpeg": 34, "IMG_5818.jpeg": 4, "IMG_5819.jpeg": 15,
  "IMG_5825.jpeg": 22,
  "z7684272505382_c6246306bfd98e30b517ecf83e168fea.jpg": 45,
  "z7684272512641_ad8f1ab954706c9fb0c3f3323e4c9318.jpg": 27,
  "z7684272609303_0427067caf3a7fc990dc1624d92df2da.jpg": 42,
  "z7684272634118_fd6cb398bd8149242fbd967023d2dd7a.jpg": 45,
  "z7706421817056_b9ad273ea1c75c9f3af8df19961ce0b8.jpg": 36,
  "z7706421874606_a5df4ab4329ae93b039b4253f6dabca9.jpg": 30,
  "z7706425611275_f11dff944c8214b8296bb7997b00b70d.jpg": 40,
};

// fields every MAIN label should carry
const CORE = ["shop_name", "order_number", "number", "line_code", "box_code", "total"];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runOne(filename) {
  const buf = readFileSync(DIR + filename);
  const mediaType = filename.toLowerCase().endsWith("png") ? "image/png" : "image/jpeg";
  let r = await fetch(`${API}/upload-url`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename, mediaType }) });
  const { jobId, key, uploadUrl } = await r.json();
  await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mediaType }, body: buf });
  await fetch(`${API}/process`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId, key, filename }) });
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    r = await fetch(`${API}/result/${jobId}`);
    const res = await r.json();
    if (res.status === "done") return { labels: res.data?.labels || [], boxCount: res.boxCount, ms: res.processingMs };
    if (res.status === "error") return { error: res.error };
  }
  return { error: "timeout" };
}

const entries = Object.entries(GROUND_TRUTH);
const settled = await Promise.all(entries.map(async ([f, truth]) => ({ f, truth, ...(await runOne(f).catch(e => ({ error: String(e.message || e) }))) })));

// A field is APPLICABLE to an image only if the label TYPE in that image carries it.
// Heuristic: applicable when at least 30% of the image's labels have the field (and >=2).
// Images whose labels never print a field (e.g. export VC35 labels have no order/total)
// are EXCLUDED from that field's denominator so they don't unfairly drag the KPI down.
const APPLICABLE_FRAC = 0.30;

console.log("\n========= FIELD COVERAGE (applicability-aware) =========");
const agg = Object.fromEntries(CORE.map(k => [k, { have: 0, of: 0, naImgs: [] }]));
for (const s of settled) {
  if (s.error) { console.log(`✗ ${s.f}: ERROR ${s.error}`); continue; }
  const L = s.labels, n = L.length;
  const per = {};
  for (const k of CORE) per[k] = L.filter(l => l.fields && String(l.fields[k] ?? "").trim()).length;
  console.log(`${s.f}  boxes=${n}`);
  console.log("   " + CORE.map(k => {
    const applicable = per[k] >= Math.max(2, Math.ceil(n * APPLICABLE_FRAC));
    if (applicable) { agg[k].have += per[k]; agg[k].of += n; return `${k}=${per[k]}/${n}`; }
    else { agg[k].naImgs.push(s.f); return `${k}=n/a`; }
  }).join("  "));
}
console.log("==========================================================");
console.log("Coverage counted ONLY on images whose label type carries the field:");
for (const k of CORE) {
  const a = agg[k];
  const pct = a.of ? (100 * a.have / a.of).toFixed(1) : "—";
  console.log(`  ${k.padEnd(13)} ${a.have}/${a.of}  (${pct}%)   ${a.naImgs.length ? "n/a in " + a.naImgs.length + " img" : ""}`);
}
const totHave = CORE.reduce((s, k) => s + agg[k].have, 0);
const totOf = CORE.reduce((s, k) => s + agg[k].of, 0);
console.log(`  OVERALL (applicable only): ${totHave}/${totOf} = ${(100 * totHave / totOf).toFixed(2)}%`);
