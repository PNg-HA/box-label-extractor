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

// OCR the FULL image once. Textract's synchronous DetectDocumentText has a 5 MB limit on the
// image bytes, so we keep the ORIGINAL RESOLUTION but drop JPEG quality (and only downscale as
// a last resort) to fit under 5 MB. Returns geom lines with coords normalized 0..1.
const TX_SYNC_LIMIT = 4_900_000;   // a touch under Textract's 5 MB sync cap
export async function ocrFullImage(orientedBuffer) {
  try {
    let buf = orientedBuffer;
    if (buf.length > TX_SYNC_LIMIT) {
      // try progressively lower quality first (keeps full resolution -> best for OCR)
      for (const q of [85, 75, 65]) {
        buf = await sharp(orientedBuffer).jpeg({ quality: q }).toBuffer();
        if (buf.length <= TX_SYNC_LIMIT) break;
      }
      // still too big -> cap width, keep decent quality
      if (buf.length > TX_SYNC_LIMIT) {
        const meta = await sharp(orientedBuffer).metadata();
        for (const wid of [4000, 3400, 2800]) {
          if (wid >= (meta.width || wid)) continue;
          buf = await sharp(orientedBuffer).resize({ width: wid }).jpeg({ quality: 82 }).toBuffer();
          if (buf.length <= TX_SYNC_LIMIT) break;
        }
      }
    }
    return await ocrLinesWithGeom(buf);   // coords already normalized 0..1
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
