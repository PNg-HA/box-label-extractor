import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";
import { fromIni } from "@aws-sdk/credential-providers";
import { readFileSync } from "fs";
import sharp from "sharp";
const client = new TextractClient({ region: "ap-southeast-1", credentials: fromIni({ profile: "gapv50k" }) });

const file = process.argv[2];
// auto-orient, keep full resolution, just ensure jpeg + under 10MB
const oriented = await sharp(readFileSync("../../" + file)).rotate().jpeg({ quality: 95 }).toBuffer();
const m = await sharp(oriented).metadata();
console.log(`${file}: full ${m.width}x${m.height} ${(oriented.length/1024/1024).toFixed(2)}MB`);

const r = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: oriented } }));
const lines = (r.Blocks||[]).filter(b=>b.BlockType==="LINE");
const words = (r.Blocks||[]).filter(b=>b.BlockType==="WORD");
const avg = words.reduce((a,b)=>a+b.Confidence,0)/words.length;
console.log(`LINES=${lines.length} WORDS=${words.length} avgConf=${avg.toFixed(1)}`);
const orders = lines.filter(b=>/DL-\d|\d{2}-\d{6}/.test(b.Text)).map(b=>b.Text);
console.log("order-ish:", orders.slice(0,12).join(" | "));
