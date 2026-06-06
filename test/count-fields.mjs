import { readFileSync } from "fs";
const API = "https://fen6lbzeah.execute-api.ap-southeast-1.amazonaws.com";
const filename = process.argv[2];
const buf = readFileSync("../../" + filename);
let r = await fetch(`${API}/upload-url`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ filename, mediaType:"image/jpeg" }) });
const { jobId, key, uploadUrl } = await r.json();
await fetch(uploadUrl, { method:"PUT", headers:{"Content-Type":"image/jpeg"}, body: buf });
await fetch(`${API}/process`, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ jobId, key, filename }) });
for (let i=0;i<240;i++){ await new Promise(s=>setTimeout(s,3000)); r=await fetch(`${API}/result/${jobId}`); const d=await r.json();
  if(d.status==="done"){
    const L=d.data.labels||[];
    const has=k=>L.filter(l=>l.fields&&l.fields[k]).length;
    console.log(`${filename} boxes=${d.boxCount}`);
    console.log(`  with time=${has("time")}  order=${has("order_number")}  date=${has("date")}  total=${has("total")}  destination=${has("destination")}  products=${L.filter(l=>l.fields&&l.fields.products&&l.fields.products.length).length}`);
    process.exit(0);
  }
  if(d.status==="error"){console.log("ERR",d.error);process.exit(1);} }
