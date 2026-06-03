import { readFileSync } from "fs";

const API = "https://fen6lbzeah.execute-api.ap-southeast-1.amazonaws.com";
const imgPath = process.argv[2];
const filename = imgPath.split(/[\\/]/).pop();
const buf = readFileSync(imgPath);
const mediaType = filename.toLowerCase().endsWith("png") ? "image/png" : "image/jpeg";
console.log("file MB:", (buf.length / 1024 / 1024).toFixed(2));

// 1. presigned url
let r = await fetch(`${API}/upload-url`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ filename, mediaType }),
});
const { jobId, key, uploadUrl } = await r.json();
console.log("jobId:", jobId);

// 2. PUT to S3
r = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": mediaType }, body: buf });
console.log("upload status:", r.status);

// 3. process
r = await fetch(`${API}/process`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jobId, key, filename }),
});
console.log("process ack:", r.status);

// 4. poll
for (let i = 0; i < 80; i++) {
  await new Promise(res => setTimeout(res, 3000));
  r = await fetch(`${API}/result/${jobId}`);
  const res = await r.json();
  if (res.status === "done" || res.status === "error") {
    console.log("FINAL:", res.status, "| boxCount:", res.boxCount, "| grid:", res.grid, "| tiles:", res.tiles);
    if (res.columnsRaw) console.log("columnsRaw:", JSON.stringify(res.columnsRaw), "-> reconciled:", JSON.stringify(res.columnsReconciled), "votes:", res.votes);
    if (res.perCell) console.log("grid:", res.grid, "perCell:", JSON.stringify(res.perCell), "rawTotal:", res.rawTotal);
    if (res.flags && res.flags.length) console.log("flags:", JSON.stringify(res.flags));
    if (res.usage) console.log("usage:", JSON.stringify(res.usage));
    console.log("first labels:", JSON.stringify((res.data?.labels || []).slice(0, 3)));
    process.exit(0);
  }
  if (i % 3 === 0) console.log(`poll ${i}: ${res.status}`);
}
console.log("timed out");
