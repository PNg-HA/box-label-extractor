import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { countHoles, detectHoles, columnCutsFromHoles } from "./holes.mjs";
import { ocrLinesWithGeom, sortLines } from "./textract.mjs";
import { intactLabelRegions, dropTornLines } from "./labelshape.mjs";

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const BEDROCK_REGION = process.env.BEDROCK_REGION || REGION;
const MODEL_ID = process.env.MODEL_ID || "global.anthropic.claude-sonnet-4-6";
const BUCKET = process.env.STORAGE_BUCKET;
const THINKING_BUDGET = parseInt(process.env.THINKING_BUDGET || "64000", 10);
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "96000", 10);
const TILE_TARGET_PX = parseInt(process.env.TILE_TARGET_PX || "1500", 10);
const VOTES = parseInt(process.env.VOTES || "3", 10);   // ensemble runs per column (all parallel)
// Cross-check tolerance: flag low confidence when |model - holes| / model exceeds this.
const CROSSCHECK_TOL = parseFloat(process.env.CROSSCHECK_TOL || "0.2");

const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION, maxAttempts: 8 });
const s3 = new S3Client({ region: REGION });

/*
 Accuracy pipeline:
 - Claude downscales any image to ~1.15 MP before the model sees it, so a dense pallet photo
   becomes unreadable -> we tile into NON-overlapping COLUMNS (each column gets the full budget,
   labels ~3x larger).
 - Per-tile preprocessing: EXIF auto-orient + contrast normalize + sharpen for crisper text.
 - ENSEMBLE: each column is counted VOTES times; ALL calls (every tile × every vote) fire in
   parallel, then per column we take the majority count and the most thorough matching labels.
   Running voters in parallel keeps latency ~= a single call.
 - A pure-image hole detector runs in parallel as a reference cross-check (never changes count).
*/

const PROMPT = `This image is a CROPPED vertical COLUMN from a photo of cardboard boxes STACKED in horizontal layers (one box on top of another). Count how many BOXES are in this column, and read each box's main label.

WHAT IS ONE BOX:
- The boxes are stacked like shelves — scan strictly TOP to BOTTOM and count each distinct box layer.
- Each box's front face normally shows: ONE round viewing hole (a dark circle) AND ONE main white printed label (delivery info: shop/destination, order code, quantity, line code).
- Use the round hole as an ANCHOR to locate each box layer — every box layer is one box. A box may show 1 OR MORE holes; that is still ONE box. Never multiply a box by its holes.
- ONE BOX = ONE entry. Count the box once.
- IF ONE BOX HAS MULTIPLE LABELS (e.g. a big main delivery label plus one or more smaller/older labels or slips): treat the box's identity as its LARGEST INTACT main label. Count the box ONCE, read that largest intact label, and ignore the smaller/extra labels. Do NOT create a separate entry for each label on the same box.
- Some boxes may be a DIFFERENT colour (e.g. a purple/printed retail box) or have a differently-styled label — still count them as a box, by their main label.

COUNT THESE: every distinct box layer that has a main white label (or, for coloured boxes, its main printed label).
DO NOT count / DO NOT create entries for:
- small secondary slips / mini stickers (a tiny "mở thùng" slip, a lone QR sticker, a handwritten note),
- labels that are torn, folded, partially peeled and unreadable,
- a main label clipped by the LEFT/RIGHT edge of this crop (it belongs to the neighbouring column),
- printed cardboard text ("VC9", "VC11.2", the recycling triangle, "UP").

METHOD: Go layer by layer from the top. For each layer, confirm it is a real box (hole and/or label visible) and record its main label. Boxes stacked tightly can look merged — separate them by their individual holes/labels. Do NOT skip a faint-but-real box, and do NOT invent boxes that are not there.

For each box, read its main label. RETURN A FIXED SET OF FIELDS with EXACTLY these key names (use the SAME keys for every box; leave a key out only if that value is truly not on the label). Do NOT invent new key spellings like product_1 / product_name_1 — products go in the "products" array described below.

Top-level fields per box (snake_case, fixed):
- shop_name        : shop/branch name with NO comma (e.g. ".HA NOI DC", "HN-RETAIL")
- destination      : full address that CONTAINS A COMMA (e.g. "HN-27 Cổ Linh, LB, Hà Nội")
- order_number     : shipment code, starts with "TO-" (letter O, not TD/T0), e.g. "TO-DL-26-074028"
- number           : the small line number like "1.1", "12.1"
- date             : the date/batch date if shown (e.g. "D23021", "02/2025")
- time             : time stamp if shown (e.g. "13:32:14")
- lot              : lot/batch code if shown
- line_code        : code on the paper label, often with -B suffix (e.g. "VC9-B", "VC11.2-B")
- box_code         : the large code PRINTED ON THE CARTON (e.g. "VC9", "VC11.2") — see BOX CODE below
- total            : the TOTAL quantity number on the label
- products         : an ARRAY (see below); omit if the label lists no products

Each element of "products" is an object with these fixed keys (include only those present):
  { "name": "<product name>", "code": "<product code e.g. F11.000>", "type": "<unit/type e.g. BU>", "grade": "<e.g. 4F+>", "size": "<e.g. 40cm>", "qty": "<quantity>" }

Read numbers/codes exactly (keep decimals like 1.26, codes like VC11.2). Labels are dense — look carefully and do not drop fields, but ALWAYS map them onto the fixed keys above.

BOX CODE (important): Each cardboard box has a large code PRINTED ON THE CARTON itself (not on the paper label), in the form "VCx" — e.g. VC9, VC11.2, VC7.5, VC4.2. This is the box type. ALWAYS record it in "box_code" with the exact value printed on the cardboard. The small paper label may also show "line_code" (often the same code with a "-B" suffix, e.g. VC9-B); record line_code too if visible, but box_code is the authoritative box type and must be filled whenever the carton code is legible.

OUTPUT: Return your final answer as raw JSON on the LAST line, exactly:
{ "box_count": <int>, "labels": [ { "fields": { "shop_name": "...", "order_number": "...", "products": [ { "name": "...", "code": "...", "qty": "..." } ], ... } } ] }
box_count MUST equal labels.length.`;

// Re-examination prompt for a column that looks under-counted. We give the model a target
// (peer columns + independent hole evidence) but explicitly forbid fabrication.
function reexamPrompt(target) {
  return PROMPT + `

RE-CHECK NOTICE: This column is part of a pallet where the neighbouring columns each have about ${target} boxes, and an independent hole detector also found about ${target} round holes in THIS column — so this column very likely has ${target} boxes too. Some labels here may be blurry, glare-covered, tilted, or hard to read, and on the previous pass some real boxes were probably SKIPPED because their label was unreadable.
Scan this column again VERY carefully, layer by layer using the round holes as anchors. Include EVERY physical box even if its label is unreadable (use {"label_readable":"no"} for those). Do NOT exceed the real number of physical box layers and do NOT invent boxes — only report boxes you can actually see as distinct layers.`;
}

async function extractFromTileWithPrompt(tileBuffer, promptText) {
  return callModelStream(tileBuffer, promptText);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function extractJson(text) {
  if (!text) throw new Error("Empty model response");
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const matches = t.match(/\{[\s\S]*\}/g);
  if (!matches) throw new Error("No JSON object found in model response");
  for (let i = matches.length - 1; i >= 0; i--) {
    try { return JSON.parse(matches[i]); } catch (_) { /* keep trying */ }
  }
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  return JSON.parse(t.slice(start, end + 1));
}

function decideGrid(width, height, holeCount) {
  // Base columns from width, but adapt to how many boxes are actually present (≈ holes).
  // Forcing 3 columns on a close-up of a few large boxes slices a box in two and over-counts.
  let cols = Math.min(4, Math.max(1, Math.round(width / TILE_TARGET_PX)));
  const isPortrait = height >= width;
  if (isPortrait && width >= 1400 && cols < 3) cols = 3;

  if (typeof holeCount === "number") {
    // few boxes -> don't over-split. Keep ~>=4 boxes per column as a rough floor.
    if (holeCount <= 6) cols = 1;
    else if (holeCount <= 12) cols = Math.min(cols, 2);
    // also never use more columns than there are boxes
    cols = Math.max(1, Math.min(cols, Math.floor(holeCount / 3) || 1));
  }
  const rows = 1; // horizontal cuts drop labels sitting on the cut line — verified empirically
  return { cols, rows };
}

// Preprocess one column crop for the LLM: cap to a budget Claude can handle.
async function makeColumnTile(oriented, left, top, w, h) {
  return sharp(oriented)
    .extract({ left, top, width: w, height: h })
    .resize({ width: 1568, height: 2400, fit: "inside", withoutEnlargement: true })
    .normalize()
    .sharpen({ sigma: 1.0 })
    .jpeg({ quality: 95 })
    .toBuffer();
}

// Crop for Textract OCR. Textract needs the PRINT to stay large enough; for tall narrow
// columns the binding dimension is WIDTH (constraining height shrinks width and kills OCR).
// So we cap WIDTH only (don't enlarge, cap ~1800) and never constrain height; then back off
// quality if needed to stay under the 5MB sync limit.
async function makeOcrTile(oriented, left, top, w, h) {
  const targetW = Math.min(w, 1800);
  let q = 88;
  for (let attempt = 0; attempt < 5; attempt++) {
    const buf = await sharp(oriented)
      .extract({ left, top, width: w, height: h })
      .resize({ width: targetW, withoutEnlargement: true })   // width only — keep print legible
      .jpeg({ quality: q })
      .toBuffer();
    if (buf.length <= 4_800_000) return buf;
    q -= 12;
  }
  return sharp(oriented).extract({ left, top, width: w, height: h })
    .resize({ width: 1400, withoutEnlargement: true }).jpeg({ quality: 62 }).toBuffer();
}

async function buildTiles(buffer) {
  const oriented = await sharp(buffer, { failOn: "none" }).rotate().toBuffer();
  const meta = await sharp(oriented).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;

  // Detect holes once: used both to decide how many columns (box density) and where to cut.
  let det = null;
  try { det = await detectHoles(oriented); } catch (_) { det = null; }
  const holeCount = det ? det.holes : undefined;

  let { cols, rows } = decideGrid(W, H, holeCount);

  // Column boundaries: only split when the holes form CONFIDENT, well-separated vertical
  // clusters (a real multi-column pallet). If clustering is weak/messy (close-ups, odd
  // layouts, too few holes), fall back to a SINGLE tile so the model sees the whole image —
  // splitting those would slice boxes and over/under-count.
  let boundaries = null;
  let cutSource = "single";
  if (rows <= 1 && cols >= 2 && det) {
    const cuts = columnCutsFromHoles(det.xs, cols);
    if (cuts && cuts.length === cols - 1 && wellSeparated(det.xs, cuts)) {
      boundaries = cuts; cutSource = "holes";
    } else {
      cols = 1; // not confident -> don't split
    }
  } else if (cols >= 2 && !det) {
    cols = 1; // no hole signal at all -> safer not to split
  }

  const xEdges = [0];
  if (boundaries) for (const c of boundaries) xEdges.push(Math.round(c * W));
  xEdges.push(W);

  const tileH = Math.floor(H / rows);
  const tiles = [];
  const ocrTiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const left = xEdges[c];
      const top = r * tileH;
      const w = xEdges[c + 1] - left;
      const h = (r === rows - 1) ? (H - top) : tileH;
      tiles.push(await makeColumnTile(oriented, left, top, w, h));
      ocrTiles.push(await makeOcrTile(oriented, left, top, w, h));
    }
  }
  return { tiles, ocrTiles, cols, rows, cutSource };
}

// Confident column split = each cut sits in a real GAP (few/no holes near it) and each
// resulting column holds a healthy share of holes. Rejects messy/sparse hole patterns.
function wellSeparated(xs, cuts) {
  if (!xs || xs.length < 15) return false;         // need a real pallet's worth of holes
  const bandsN = cuts.length + 1;
  const edges = [0, ...cuts, 1];
  const counts = new Array(bandsN).fill(0);
  for (const x of xs) {
    for (let b = 0; b < bandsN; b++) {
      if (x >= edges[b] && x < edges[b + 1]) { counts[b]++; break; }
    }
  }
  // every column must hold a healthy share AND an absolute minimum of holes (a real
  // multi-column stack has many holes per column; a close-up of a few boxes does not).
  const minShare = Math.max(4, Math.floor(xs.length * 0.2));
  if (counts.some(c => c < minShare)) return false;
  // each cut must sit in a gap: few holes within a small margin around it
  const margin = 0.04;
  for (const cut of cuts) {
    const near = xs.filter(x => Math.abs(x - cut) < margin).length;
    if (near > Math.max(1, xs.length * 0.06)) return false;
  }
  return true;
}

// Retry wrapper: under heavy parallelism Bedrock can throttle. Retry transient errors
// (throttling / 5xx / timeouts) with exponential backoff + jitter.
const RETRYABLE = new Set([
  "ThrottlingException", "TooManyRequestsException", "ServiceUnavailableException",
  "InternalServerException", "ModelTimeoutException", "ServiceQuotaExceededException",
]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callModelStream(tileBuffer, promptText) {
  const maxAttempts = 6;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await bedrock.send(new ConverseStreamCommand({
        modelId: MODEL_ID,
        messages: [
          { role: "user", content: [ { image: { format: "jpeg", source: { bytes: tileBuffer } } }, { text: promptText } ] },
        ],
        inferenceConfig: { maxTokens: MAX_TOKENS },
        additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET } },
      }));
      let text = "", usage = {};
      for await (const ev of res.stream) {
        const delta = ev.contentBlockDelta?.delta;
        if (delta?.text) text += delta.text;        // only normal text, not reasoning
        if (ev.metadata?.usage) usage = ev.metadata.usage;
      }
      const data = extractJson(text);
      const labels = Array.isArray(data.labels) ? data.labels.map(l => ({ fields: l.fields || {} })) : [];
      return { count: labels.length, labels, usage };
    } catch (err) {
      lastErr = err;
      const name = err?.name || "";
      const retryable = RETRYABLE.has(name) || err?.$retryable || /throttl|timeout|rate/i.test(String(err?.message));
      if (!retryable || attempt === maxAttempts - 1) throw err;
      const backoff = Math.min(20000, 800 * 2 ** attempt) + Math.floor(Math.random() * 500);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function ocrBlock(ocr) {
  if (!ocr || !ocr.length) return "";
  // cap to keep prompt size reasonable on very dense tiles
  const lines = ocr.slice(0, 400);
  return `

OCR REFERENCE (from Amazon Textract, read top-to-bottom). These are the exact characters detected on this crop — trust them for spelling/digits when a field is hard to read in the image (e.g. order numbers start with "TO-", codes like "VC9-B"). Do NOT use this list to change the BOX COUNT; count boxes from the image as instructed. Use it only to read field VALUES more accurately:
<<<OCR
${lines.join("\n")}
OCR>>>`;
}

async function extractFromTile(tileBuffer, ocr) {
  return callModelStream(tileBuffer, PROMPT + ocrBlock(ocr));
}

function modeWithTieHigh(nums) {
  const freq = new Map();
  for (const n of nums) freq.set(n, (freq.get(n) || 0) + 1);
  let best = nums[0], bestF = -1;
  for (const [v, f] of freq) if (f > bestF || (f === bestF && v > best)) { best = v; bestF = f; }
  return best;
}

// pick the labels from the run that matches `count` and has the most filled fields
function pickLabels(runs, count) {
  const matching = runs.filter(r => r.count === count);
  const pool = matching.length ? matching : runs;
  let best = pool[0], bestScore = -1;
  for (const r of pool) {
    const score = r.labels.reduce((s, l) => s + Object.keys(l.fields || {}).length, 0);
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best.labels;
}

// Normalize a VC line code to its BASE code, grouping suffix variants together:
// "VC9-B"/"VC9 B"/"vc9b" -> "VC9", "VC11.2-B" -> "VC11.2". The trailing -letter (e.g. -B)
// is dropped so VC9 and VC9-B count as the same type.
function normLineCode(v) {
  if (v == null) return null;
  const s = String(v).toUpperCase().replace(/\s+/g, "");
  const m = s.match(/VC\d+(?:\.\d+)?/);   // base code only: VC9, VC11.2, VC4.2, VC7.5 ...
  return m ? m[0] : null;
}

// Count boxes per VC code. The carton code printed on the cardboard (box_code, e.g. "VC9")
// is the most reliable signal — the small label's line_code is often misread (e.g. VC9-B -> VCD-B).
// So we look at box_code first, then other code fields, then scan ALL fields for any VC pattern.
function summarizeLineCodes(labels) {
  const counts = new Map();
  const prefFields = ["box_code", "line_code_box", "carton_code", "box", "line_code", "lineCode", "line"];
  for (const l of labels) {
    const f = l.fields || {};
    let code = null;
    for (const k of prefFields) { const n = normLineCode(f[k]); if (n) { code = n; break; } }
    if (!code) {  // last resort: any field value containing a VC code
      for (const v of Object.values(f)) { const n = normLineCode(v); if (n) { code = n; break; } }
    }
    code = code || "unknown";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
}

async function putResult(jobId, obj) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `results/${jobId}.json`,
    Body: JSON.stringify(obj),
    ContentType: "application/json",
  }));
}

export const handler = async (event) => {
  const { jobId, key, filename } = event;
  const name = (filename || "image").replace(/\.[^.]+$/, "");
  const startedAt = Date.now();
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buffer = await streamToBuffer(obj.Body);

    const { tiles, ocrTiles, cols, rows, cutSource } = await buildTiles(buffer);

    // Textract OCR each column on a HIGH-RES crop (small print needs resolution — the shrunk
    // LLM tile returns almost no text). Detect intact-label regions on the SAME crop so the
    // OCR-line coordinates align, then DROP only text on regions proven to be TORN.
    const ocrPerTile = await Promise.all(ocrTiles.map(async (t) => {
      const [linesGeom, shape] = await Promise.all([ ocrLinesWithGeom(t), intactLabelRegions(t) ]);
      const kept = dropTornLines(linesGeom, shape.intact, shape.torn);
      return sortLines(kept);
    }));

    // ENSEMBLE + per-column hole cross-check: fire every tile × every vote in parallel,
    // and detect holes on each column tile (reference signal, per column).
    const tileVotePromises = tiles.map((t, i) =>
      Array.from({ length: VOTES }, () => extractFromTile(t, ocrPerTile[i]))
    );

    const [allTileRuns, holesPerCol] = await Promise.all([
      Promise.all(tileVotePromises.map(votes => Promise.allSettled(votes))),
      Promise.all(tiles.map(t => countHoles(t))),
    ]);

    // Per column: majority-vote the count, keep that column's best labels.
    const colLabels = [];   // colLabels[i] = labels array for column i
    const colCounts = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    for (const settled of allTileRuns) {
      const runs = settled.filter(s => s.status === "fulfilled").map(s => s.value);
      for (const r of runs) {
        usage.inputTokens += r.usage?.inputTokens || 0;
        usage.outputTokens += r.usage?.outputTokens || 0;
      }
      if (!runs.length) { colLabels.push([]); colCounts.push(0); continue; }
      const count = modeWithTieHigh(runs.map(r => r.count));
      const picked = pickLabels(runs, count);
      colLabels.push(picked);
      colCounts.push(picked.length);
    }

    const holesEqual = holesPerCol.every(h => h != null) &&
      (Math.max(...holesPerCol) - Math.min(...holesPerCol) <= 2);

    // RE-EXAMINE under-counted columns. Trigger when a column is >=2 below the tallest peer
    // AND the independent hole detector says the columns are roughly equal-height. We give the
    // model the target as evidence but forbid fabrication; only accept a HIGHER count, capped
    // at the target, and run a small ensemble for stability.
    const reexamFlags = [];
    if (cols >= 3) {
      const maxCol = Math.max(...colCounts);
      for (let i = 0; i < cols; i++) {
        const gap = maxCol - colCounts[i];
        if (gap >= 2 && holesEqual) {
          const target = maxCol;
          try {
            const reRuns = await Promise.all(
              Array.from({ length: VOTES }, () => extractFromTileWithPrompt(tiles[i], reexamPrompt(target) + ocrBlock(ocrPerTile[i])))
            );
            for (const r of reRuns) {
              usage.inputTokens += r.usage?.inputTokens || 0;
              usage.outputTokens += r.usage?.outputTokens || 0;
            }
            const newCount = modeWithTieHigh(reRuns.map(r => r.count));
            // accept only an increase, and never above the target (no fabrication beyond evidence)
            if (newCount > colCounts[i]) {
              const accepted = Math.min(newCount, target);
              const newLabels = pickLabels(reRuns, accepted);
              reexamFlags.push(`col${i + 1}: ${colCounts[i]} -> ${accepted} after re-exam (target ${target})`);
              colLabels[i] = newLabels.slice(0, accepted).length ? newLabels : colLabels[i];
              colCounts[i] = colLabels[i].length;
            } else {
              reexamFlags.push(`col${i + 1}: re-exam kept ${colCounts[i]} (model found no more)`);
            }
          } catch (e) {
            reexamFlags.push(`col${i + 1}: re-exam failed (${String(e.message).slice(0, 40)})`);
          }
        }
      }
    }

    // assemble final labels
    const merged = [];
    for (const labels of colLabels) for (const l of labels) merged.push({ fields: l.fields || {} });
    merged.forEach((l, i) => { l.index = i + 1; });

    const boxCount = merged.length;
    const holeCount = holesPerCol.reduce((a, h) => a + (h || 0), 0);

    // Breakdown by VC line code: how many boxes of each type (e.g. VC9-B: 5, VC11.2-B: 5).
    const lineCodeSummary = summarizeLineCodes(merged);

    // Cross-check flag (reference only): if a column still looks short after re-exam.
    const flags = [...reexamFlags];
    let lowConfidence = false;
    for (let i = 0; i < cols; i++) {
      const h = holesPerCol[i];
      if (h != null && h - colCounts[i] >= 3 && (h - colCounts[i]) / Math.max(1, h) > CROSSCHECK_TOL) {
        lowConfidence = true;
        flags.push(`col${i + 1}: model ${colCounts[i]} vs ~${h} holes — may have missed boxes`);
      }
    }
    if (cols >= 3) {
      const maxCol = Math.max(...colCounts);
      for (let i = 0; i < cols; i++) {
        const gap = maxCol - colCounts[i];
        if (gap >= 3 || (gap >= 2 && holesEqual)) {
          lowConfidence = true;
          flags.push(`col${i + 1}: ${colCounts[i]} below tallest column (${maxCol})${holesEqual ? " though hole counts are equal" : ""} — please verify`);
        }
      }
    }
    const crossCheckNote = lowConfidence
      ? `Count may be off in one column — ${flags.join("; ")}.`
      : (reexamFlags.length ? reexamFlags.join("; ") : null);

    await putResult(jobId, {
      status: "done",
      jobId, filename, name,
      boxCount,
      grid: `${cols}x${rows}`,
      cutSource,
      ocrUsed: ocrPerTile.some(o => o && o.length > 0),
      tiles: tiles.length,
      votes: VOTES,
      columnCounts: colCounts,
      holesPerColumn: holesPerCol,
      holeCount,
      lineCodeSummary,
      reexamined: reexamFlags,
      lowConfidence,
      crossCheckNote,
      data: { box_count: boxCount, line_code_summary: lineCodeSummary, labels: merged },
      model: MODEL_ID,
      usage,
      processingMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Worker error:", err);
    await putResult(jobId, {
      status: "error",
      jobId, filename, name,
      error: String(err?.message || err),
      processingMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
};
