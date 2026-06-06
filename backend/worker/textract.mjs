import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";
import sharp from "sharp";

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const textract = new TextractClient({ region: REGION, maxAttempts: 6 });

/*
 OCR a column tile with Amazon Textract and return the detected text LINES (top-to-bottom,
 left-to-right). Textract reads characters far more accurately than the vision LLM on dense
 printed labels, so we pass these lines to Claude as a trusted "OCR reference" to fix
 misreads (e.g. order TO-DL-26-... vs TD-DL-35-...). Returns [] on any failure so the main
 pipeline never breaks.
*/
export async function ocrLinesWithGeom(tileBuffer) {
  try {
    const res = await textract.send(new DetectDocumentTextCommand({ Document: { Bytes: tileBuffer } }));
    return (res.Blocks || [])
      .filter(b => b.BlockType === "LINE" && b.Text)
      .map(b => ({
        text: b.Text,
        top: b.Geometry?.BoundingBox?.Top ?? 0,
        left: b.Geometry?.BoundingBox?.Left ?? 0,
        width: b.Geometry?.BoundingBox?.Width ?? 0,
        height: b.Geometry?.BoundingBox?.Height ?? 0,
      }));
  } catch (e) {
    return [];
  }
}

// OCR the FULL image once. Textract works at full resolution (no 1568px LLM limit), so we do
// NOT tile or rescale for OCR — we just keep the original under Textract's 10MB sync limit.
// Returns geom lines with coords normalized 0..1 (so we can slice them per column afterwards).
export async function ocrFullImage(orientedBuffer) {
  try {
    let buf = orientedBuffer;
    // keep under the 10MB sync cap; only down-quality if needed (avoid resizing if possible)
    if (buf.length > 9_500_000) {
      buf = await sharp(orientedBuffer).jpeg({ quality: 85 }).toBuffer();
      if (buf.length > 9_500_000) {
        const meta = await sharp(orientedBuffer).metadata();
        buf = await sharp(orientedBuffer).resize({ width: Math.min(meta.width, 4000) }).jpeg({ quality: 88 }).toBuffer();
      }
    }
    return await ocrLinesWithGeom(buf);   // already normalized 0..1
  } catch (e) {
    return [];
  }
}

export function sortLines(lines) {
  return lines.slice().sort((a, b) => (a.top - b.top) || (a.left - b.left)).map(l => l.text);
}

export async function ocrLines(tileBuffer) {
  return sortLines(await ocrLinesWithGeom(tileBuffer));
}
