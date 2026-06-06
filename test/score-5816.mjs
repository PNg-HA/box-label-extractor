import { readFileSync } from "fs";
const API = "https://fen6lbzeah.execute-api.ap-southeast-1.amazonaws.com";
const file = "IMG_5816.jpeg";
const gt = JSON.parse(readFileSync("gt-5816.json", "utf8"));

const norm = s => String(s ?? "").toUpperCase().replace(/[^A-Z0-9.]+/g, "");
// lenient: ignore a leading dot and "HN-" area prefix differences for shop names
const normShop = s => norm(s).replace(/^\.+/, "").replace(/^HN/, "");
const buf = readFileSync("../../" + file);
let r = await fetch(`${API}/upload-url`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ filename:file, mediaType:"image/jpeg" }) });
const { jobId, key, uploadUrl } = await r.json();
await fetch(uploadUrl, { method:"PUT", headers:{"Content-Type":"image/jpeg"}, body: buf });
await fetch(`${API}/process`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ jobId, key, filename:file }) });
let L = null;
for (let i=0;i<120;i++){ await new Promise(s=>setTimeout(s,3000)); r=await fetch(`${API}/result/${jobId}`); const d=await r.json();
  if(d.status==="done"){ L=d.data.labels||[]; break; } if(d.status==="error"){ console.log("ERR",d.error); process.exit(1);} }
if(!L){console.log("timeout");process.exit(1);}

console.log(`boxes got=${L.length} truth=${gt.shop.length}`);
const fields = [["shop","shop_name"],["order","order_number"],["box_type","box_code"]];
const stat = {};
for (const [g] of fields) stat[g] = { correct:0, present:0 };
const n = Math.min(L.length, gt.shop.length);
for (let i=0;i<n;i++){
  const f = L[i].fields||{};
  for (const [g, k] of fields){
    const got = g === "shop" ? normShop(f[k]) : norm(f[k]);
    const want = g === "shop" ? normShop(gt[g][i]) : norm(gt[g][i]);
    if (norm(f[k])) stat[g].present++;
    if (got && got===want) stat[g].correct++;
    else if (got && got!==want) console.log(`  [${g}] box${i+1}: got "${f[k]}" want "${gt[g][i]}"`);
  }
}
console.log("\n=== ACCURACY vs ChatGPT ground-truth (IMG_5816) ===");
for (const [g] of fields){
  const s = stat[g];
  console.log(`  ${g.padEnd(9)} correct ${s.correct}/${n} (${(100*s.correct/n).toFixed(1)}%)  present ${s.present}/${n}`);
}
