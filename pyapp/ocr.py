"""
OCR module. Reads the text on a cropped label using either:
  - Amazon Textract  (engine="textract")  -> fast, accurate characters, raw lines
  - Amazon Bedrock Claude Sonnet 4.6 (engine="bedrock") -> structured JSON per label

Detection is done by detector.py (OpenCV); this module only reads cropped label images.
"""
from __future__ import annotations
import json, time, base64
import cv2
import numpy as np
import boto3

REGION = "ap-southeast-1"
BEDROCK_MODEL = "global.anthropic.claude-sonnet-4-6"

_session = None
def session(profile: str = "gapv50k"):
    global _session
    if _session is None:
        _session = boto3.Session(profile_name=profile, region_name=REGION)
    return _session


def _encode(crop_bgr: np.ndarray, max_w: int = 1300, quality: int = 95) -> bytes:
    """Upscale small crops so text is large, JPEG-encode for the OCR services."""
    h, w = crop_bgr.shape[:2]
    if w < max_w:
        scale = max_w / float(w)
        crop_bgr = cv2.resize(crop_bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    ok, buf = cv2.imencode(".jpg", crop_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes()


def textract_lines(crop_bgr: np.ndarray, profile: str = "gapv50k") -> list[str]:
    tx = session(profile).client("textract")
    data = _encode(crop_bgr)
    for attempt in range(6):
        try:
            r = tx.detect_document_text(Document={"Bytes": data})
            return [b["Text"] for b in r["Blocks"] if b["BlockType"] == "LINE"]
        except Exception as e:
            name = type(e).__name__
            if "Throttl" in name or "Throughput" in name or "ProvisionedThroughput" in name:
                time.sleep(1.5 * (attempt + 1)); continue
            raise
    return []


PROMPT = """You are reading ONE warehouse box label (a cropped image). Extract its fields as JSON.

Use exactly these keys when present (omit if truly absent):
- shop_name: branch/shop name WITHOUT a comma (e.g. ".HA NOI DC", "HN-RETAIL")
- destination: full address that CONTAINS A COMMA (e.g. "HN-27 Co Linh, LB, Ha Noi")
- order_number: starts with "TO-" (letter O), e.g. "TO-DL-26-074028"
- number: small line number like "1.1"
- date / lot: date or batch codes shown (e.g. "D23021")
- time: time stamp e.g. "13:32:14"
- line_code: code on the paper label, often with -B suffix (e.g. "VC9-B")
- box_code: the large code printed on the carton (e.g. "VC9")
- total: total quantity number
- products: array of { name, code, type, grade, size, qty } for each product row

Return ONLY raw JSON: { "fields": { ... } }
"""

def bedrock_fields(crop_bgr: np.ndarray, profile: str = "gapv50k", ocr_hint: list[str] | None = None) -> dict:
    br = session(profile).client("bedrock-runtime")
    data = _encode(crop_bgr)
    content = [{"image": {"format": "jpeg", "source": {"bytes": data}}}]
    prompt = PROMPT
    if ocr_hint:
        prompt += "\n\nOCR REFERENCE (Amazon Textract, trust for spelling/digits):\n" + "\n".join(ocr_hint[:60])
    content.append({"text": prompt})
    for attempt in range(6):
        try:
            r = br.converse(
                modelId=BEDROCK_MODEL,
                messages=[{"role": "user", "content": content}],
                inferenceConfig={"maxTokens": 2000, "temperature": 0},
            )
            text = "".join(p.get("text", "") for p in r["output"]["message"]["content"])
            s, e = text.find("{"), text.rfind("}")
            return json.loads(text[s:e + 1]).get("fields", {})
        except Exception as ex:
            name = type(ex).__name__
            if "Throttl" in name or "TooManyRequests" in name:
                time.sleep(1.5 * (attempt + 1)); continue
            if attempt == 5:
                return {}
            raise
    return {}
