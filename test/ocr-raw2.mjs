import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";
import { fromIni } from "@aws-sdk/credential-providers";
import { readFileSync } from "fs";
import sharp from "sharp";
const client = new TextractClient({ region: "ap-southeast-1", credentials: fromIni({ profile: "gapv50k" }) });

const file = process.argv[2], col = parseInt(process.argv[3] ?? "0", 10);
const oriented = await sharp(readFileSync("../../" + file)).rotate().toBuffer();
const meta = await sharp(oriented).metadata();
const W = meta.width, H = meta.height, tileW = Math.floor(W / 3);
const left = col * tileW, w = col === 2 ? W - left : tileW;
// width-capped to 1800 like the worker does
const buf = await sharp(oriented).extract({ left, top:0, width:w, height:H }).resize({ width: Math.min(w,1800), withoutEnlargement:true }).jpeg({ quality: 88 }).toBuffer();
const m = await sharp(buf).metadata();
const r = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: buf } }));
const lines = (r.Blocks||[]).filter(b=>b.BlockType==="LINE").map(b=>b.Text);
const words = (r.Blocks||[]).filter(b=>b.BlockType==="WORD");
const lowConf = words.filter(b=>b.Confidence < 80).map(b=>`${b.Text}(${b.Confidence.toFixed(0)})`);
console.log(`${file} col${col}: tile ${m.width}x${m.height}, LINES=${lines.length}, WORDS=${words.length}`);
console.log("avg word conf:", (words.reduce((a,b)=>a+b.Confidence,0)/words.length).toFixed(1));
console.log("low-conf words(<80):", lowConf.slice(0,30).join("  "));
console.log("--- first 25 lines ---");
console.log(lines.slice(0,25).join("\n"));
