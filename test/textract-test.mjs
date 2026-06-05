// Evaluate Amazon Textract OCR on a label image. Textract caps sync images at 5MB and
// downsamples large images, so we test on a single column tile (where labels are larger).
import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";
import { fromIni } from "@aws-sdk/credential-providers";
import { readFileSync } from "fs";
import sharp from "sharp";

const client = new TextractClient({ region: "ap-southeast-1", credentials: fromIni({ profile: "gapv50k" }) });

const file = process.argv[2];
const colArg = process.argv[3]; // optional: 0/1/2 to crop one column, else whole image scaled

const oriented = await sharp(readFileSync("../../" + file)).rotate().toBuffer();
const meta = await sharp(oriented).metadata();
const W = meta.width, H = meta.height;

let buf;
if (colArg != null) {
  const col = parseInt(colArg, 10);
  const tileW = Math.floor(W / 3);
  const left = col * tileW;
  const w = col === 2 ? W - left : tileW;
  buf = await sharp(oriented).extract({ left, top: 0, width: w, height: H })
    .resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
} else {
  buf = await sharp(oriented).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}
console.log(`${file} ${colArg!=null?`col${colArg}`:"full"} -> ${(buf.length/1024).toFixed(0)}KB`);

const res = await client.send(new DetectDocumentTextCommand({ Document: { Bytes: buf } }));
const lines = (res.Blocks || []).filter(b => b.BlockType === "LINE").map(b => b.Text);
console.log("LINE count:", lines.length);
console.log(lines.join("\n"));
