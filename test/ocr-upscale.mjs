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
const colBuf = await sharp(oriented).extract({ left, top:0, width:w, height:H }).toBuffer();
const cm = await sharp(colBuf).metadata();

async function run(label, buf) {
  const m = await sharp(buf).metadata();
  const r = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: buf } }));
  const words = (r.Blocks||[]).filter(b=>b.BlockType==="WORD");
  const avg = words.length? words.reduce((a,b)=>a+b.Confidence,0)/words.length : 0;
  const orders = (r.Blocks||[]).filter(b=>b.BlockType==="LINE"&&/\d{2}-\d{6}|DL-\d/.test(b.Text)).map(b=>b.Text);
  console.log(`${label}: ${m.width}x${m.height} ${(buf.length/1024).toFixed(0)}KB words=${words.length} avgConf=${avg.toFixed(1)}`);
  console.log("   order-ish:", orders.slice(0,5).join(" | "));
}

await run("native-cap1800", await sharp(colBuf).resize({width:Math.min(cm.width,1800),withoutEnlargement:true}).jpeg({quality:88}).toBuffer());
await run("upscale x2 lanczos", await sharp(colBuf).resize({width:cm.width*2,kernel:"lanczos3"}).sharpen().jpeg({quality:92}).toBuffer());
await run("upscale to 1400w", await sharp(colBuf).resize({width:1400,kernel:"lanczos3"}).sharpen().jpeg({quality:92}).toBuffer());
