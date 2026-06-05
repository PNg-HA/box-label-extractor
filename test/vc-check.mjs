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
    console.log(filename, "box", d.boxCount, "| VC:", JSON.stringify(d.lineCodeSummary));
    const bc = (d.data.labels||[]).map(l => (l.fields||{}).box_code || (l.fields||{}).line_code_box || "-");
    console.log("  box_codes:", bc.join(" "));
    process.exit(0);
  }
  if(d.status==="error"){console.log("ERR",d.error);process.exit(1);} }
