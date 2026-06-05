import { TextractClient, DetectDocumentTextCommand } from "@aws-sdk/client-textract";

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const textract = new TextractClient({ region: REGION, maxAttempts: 6 });

/*
 OCR a column tile with Amazon Textract and return the detected text LINES (top-to-bottom,
 left-to-right). Textract reads characters far more accurately than the vision LLM on dense
 printed labels, so we pass these lines to Claude as a trusted "OCR reference" to fix
 misreads (e.g. order TO-DL-26-... vs TD-DL-35-...). Returns [] on any failure so the main
 pipeline never breaks.
*/
export async function ocrLines(tileBuffer) {
  try {
    const res = await textract.send(new DetectDocumentTextCommand({ Document: { Bytes: tileBuffer } }));
    const lines = (res.Blocks || [])
      .filter(b => b.BlockType === "LINE" && b.Text)
      .map(b => ({
        text: b.Text,
        top: b.Geometry?.BoundingBox?.Top ?? 0,
        left: b.Geometry?.BoundingBox?.Left ?? 0,
      }))
      .sort((a, b) => (a.top - b.top) || (a.left - b.left))
      .map(l => l.text);
    return lines;
  } catch (e) {
    return [];
  }
}
