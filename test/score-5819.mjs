import { readFileSync } from "fs";
const API = "https://fen6lbzeah.execute-api.ap-southeast-1.amazonaws.com";
const file = "IMG_5819.jpeg";
const gt = JSON.parse(readFileSync("gt-5819.json", "utf8"));
const norm = s => String(s ?? "").toUpperCase().replace(/[^A-Z0-9.]+/g, "");
const buf = readFileSync("../../" + file);
let r = await fetch(`${API}/upload-url`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ filename:file, mediaType:"image/jpeg" }) });
const { jobId, key, uploadUrl } = await r.json();
await fetch(uploadUrl, { method:"PUT", headers:{"Content-Type":"image/jpeg"}, body: buf });
await fetch(`${API}/process`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ jobId, key, filename:file }) });
let L=null;
for (let i=0;i<120;i++){ await new Promise(s=>setTimeout(s,3000)); r=await fetch(`${API}/result/${jobId}`); const d=await r.json();
  if(d.status==="done"){ L=d.data.labels||[]; break; } if(d.status==="error"){console.log("ERR",d.error);process.exit(1);} }
if(!L){console.log("timeout");process.exit(1);}
console.log(`boxes got=${L.length} truth=${gt.box_type.length}`);
// label_number can be in number/label_number/products; gather a flat set of numbers per label
const fields=[["box_type","box_code"],["total","total"]];
const stat={}; for(const[g] of fields) stat[g]={c:0,p:0};
const n=Math.min(L.length, gt.box_type.length);
for(let i=0;i<n;i++){ const f=L[i].fields||{};
  for(const[g,k] of fields){ const got=norm(f[k]); const want=norm(gt[g][i]);
    if(got)stat[g].p++; if(got&&got===want)stat[g].c++;
    else if(got&&got!==want) console.log(`  [${g}] box${i+1}: got "${f[k]}" want "${gt[g][i]}"`); } }
console.log("\n=== ACCURACY vs ground-truth (IMG_5819, VC35 export) ===");
for(const[g] of fields){ const s=stat[g]; console.log(`  ${g.padEnd(9)} correct ${s.c}/${n} (${(100*s.c/n).toFixed(1)}%) present ${s.p}/${n}`); }
