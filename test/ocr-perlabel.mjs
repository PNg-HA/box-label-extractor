// Compare: Textract on the whole column vs Textract on each INTACT label cropped at high res.
import { readFileSync } from "fs";
import sharp from "sharp";
import { ocrLinesWithGeom } from "../backend/worker/textract.mjs";
import { intactLabelRegions } from "../backend/worker/labelshape.mjs";

const file = process.argv[2], col = parseInt(process.argv[3] ?? "0", 10);
const oriented = await sharp(readFileSync("../../" + file)).rotate().toBuffer();
const meta = await sharp(oriented).metadata();
const W = meta.width, H = meta.height, tileW = Math.floor(W / 3);
const left = col * tileW, w = col === 2 ? W - left : tileW;
const colBuf = await sharp(oriented).extract({ left, top: 0, width: w, height: H }).toBuffer();
const cm = await sharp(colBuf).metadata();
console.log(`col native ${cm.width}x${cm.height}`);

// region detection runs on a width-capped version (same as worker)
const ocrTile = await sharp(colBuf).resize({ width: Math.min(cm.width, 1800), withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
const shape = await intactLabelRegions(ocrTile);
console.log(`intact regions: ${shape.intact.length}`);

// OCR each intact label cropped from the NATIVE column and upscaled so text is big
let idx = 0;
for (const r of shape.intact.slice(0, 3)) {
  idx++;
  const lx = Math.floor(r.x0 * cm.width), ly = Math.floor(r.y0 * cm.height);
  const lw = Math.ceil((r.x1 - r.x0) * cm.width), lh = Math.ceil((r.y1 - r.y0) * cm.height);
  // pad a little
  const px = Math.max(0, lx - 10), py = Math.max(0, ly - 10);
  const pw = Math.min(cm.width - px, lw + 20), ph = Math.min(cm.height - py, lh + 20);
  // upscale the single label to ~1600 wide for max OCR fidelity
  const labelBuf = await sharp(colBuf).extract({ left: px, top: py, width: pw, height: ph })
    .resize({ width: 1600, withoutEnlargement: false }).sharpen().jpeg({ quality: 95 }).toBuffer();
  const lines = await ocrLinesWithGeom(labelBuf);
  console.log(`\n--- label ${idx} (rect ${r.rect}) ${pw}x${ph} -> upscaled ---`);
  console.log(lines.map(l => l.text).join(" | "));
}
