const CFG = window.APP_CONFIG || {};
const API = (CFG.API_BASE || "").replace(/\/$/, "");

const els = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  pickBtn: document.getElementById("pickBtn"),
  processBtn: document.getElementById("processBtn"),
  downloadAllBtn: document.getElementById("downloadAllBtn"),
  clearBtn: document.getElementById("clearBtn"),
  cards: document.getElementById("cards"),
  globalSummary: document.getElementById("globalSummary"),
  apiBadge: document.getElementById("apiBadge"),
};

els.apiBadge.textContent = `${CFG.MODEL || "Claude"} · ${CFG.REGION || ""} · API ${API}`;

// state: list of jobs
// { id, file, name(no ext), previewUrl, status, jobId, result, boxCount, error }
const jobs = [];
let counter = 0;

function stripExt(filename) {
  return filename.replace(/\.[^.]+$/, "");
}

// Upload the FULL-RESOLUTION original directly to S3 via a presigned URL.
// No client-side downscaling: the worker needs full detail to tile the image
// and count every label accurately. Presigned PUT also bypasses the API
// Gateway / Lambda 6 MB request limit.

function addFiles(fileList) {
  for (const file of fileList) {
    if (!file.type.startsWith("image/")) continue;
    counter += 1;
    jobs.push({
      id: `job-${counter}`,
      file,
      name: stripExt(file.name),
      filename: file.name,
      previewUrl: URL.createObjectURL(file),
      status: "queued",
      jobId: null,
      result: null,
      boxCount: null,
      error: null,
    });
  }
  render();
  updateControls();
}

function updateControls() {
  const hasJobs = jobs.length > 0;
  const anyDone = jobs.some(j => j.status === "done");
  const busy = jobs.some(j => j.status === "processing" || j.status === "uploading");
  els.processBtn.disabled = !hasJobs || busy;
  els.downloadAllBtn.disabled = !anyDone;
  els.clearBtn.disabled = !hasJobs || busy;

  const done = jobs.filter(j => j.status === "done").length;
  const totalBoxes = jobs.reduce((s, j) => s + (j.boxCount || 0), 0);
  if (hasJobs) {
    els.globalSummary.textContent =
      `${jobs.length} ảnh · ${done} hoàn tất · tổng ${totalBoxes} thùng`;
  } else {
    els.globalSummary.textContent = "";
  }
}

function syntaxHighlight(obj) {
  let json = JSON.stringify(obj, null, 2);
  json = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return json.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match) => {
      let cls = "n";
      if (/^"/.test(match)) cls = /:$/.test(match) ? "k" : "s";
      else if (/true|false|null/.test(match)) cls = "b";
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function statusBadge(job) {
  if (job.status === "done") return `<span class="badge done">Hoàn tất</span>`;
  if (job.status === "error") return `<span class="badge error">Lỗi</span>`;
  if (job.status === "processing" || job.status === "uploading")
    return `<span class="badge processing"><span class="spinner"></span> Đang xử lý</span>`;
  return `<span class="badge queued">Chờ xử lý</span>`;
}

function render() {
  els.cards.innerHTML = "";
  for (const job of jobs) {
    const card = document.createElement("div");
    card.className = "card";
    card.id = job.id;

    const countPill = job.status === "done"
      ? `<span class="count-pill${job.lowConfidence ? " warn" : ""}">${job.boxCount} thùng${job.lowConfidence ? " ⚠" : ""}</span>${typeof job.processingMs === "number" ? `<span class="time-pill">${(job.processingMs/1000).toFixed(1)}s</span>` : ""}` : "";

    let body = "";
    if (job.status === "done" && job.result) {
      const warn = job.lowConfidence
        ? `<div class="warn-msg">⚠ ${job.crossCheckNote || "Số đếm có thể chưa chính xác — nên kiểm tra lại."}${typeof job.holeCount === "number" ? ` (phát hiện ~${job.holeCount} lỗ tròn)` : ""}</div>`
        : "";
      const lcs = job.result.line_code_summary || {};
      const lcEntries = Object.entries(lcs);
      const vcSummary = lcEntries.length
        ? `<div class="vc-summary">${lcEntries.map(([k, v]) =>
            `<span class="vc-chip"><b>${v}</b> ${k}</span>`).join("")}</div>`
        : "";
      body = `${warn}${vcSummary}<pre class="json">${syntaxHighlight(job.result)}</pre>`;
    } else if (job.status === "error") {
      body = `<div class="err-msg">${job.error || "Đã xảy ra lỗi"}</div>`;
    } else {
      body = `<pre class="json">// ${job.status === "queued" ? "Chưa xử lý" : "Đang trích xuất nhãn..."}</pre>`;
    }

    const actions = job.status === "done"
      ? `<div class="card-actions">
           <button class="btn small" data-csv="${job.id}">Tải CSV</button>
           <button class="btn small ghost" data-json="${job.id}">Tải JSON</button>
         </div>` : "";

    card.innerHTML = `
      <div class="card-head">
        <img class="thumb" src="${job.previewUrl}" alt="" />
        <div class="card-title">
          <div class="fname">${job.filename}</div>
          <div class="json-name">${job.name}.json</div>
        </div>
        ${countPill}
        ${statusBadge(job)}
      </div>
      <div class="card-body">${body}</div>
      ${actions}
    `;
    els.cards.appendChild(card);
  }

  els.cards.querySelectorAll("[data-csv]").forEach(b =>
    b.addEventListener("click", () => downloadCsv(b.dataset.csv)));
  els.cards.querySelectorAll("[data-json]").forEach(b =>
    b.addEventListener("click", () => downloadJson(b.dataset.json)));
}

// ---- Processing ----
const MAX_PARALLEL = 20; // process up to 20 images at once (each = its own pipeline/invoke)

async function processAll() {
  updateControls();
  // Run jobs in parallel with a concurrency cap. Each job is fully independent
  // (its own presigned upload + worker invoke), so they don't share model context.
  const queue = jobs.filter(j => j.status !== "done");
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      await processJob(job);
    }
  }
  const lanes = Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, () => worker());
  await Promise.all(lanes);
  updateControls();
}

async function processJob(job) {
  try {
    job.status = "uploading";
    render(); updateControls();

    // 1. Ask the API for a presigned upload URL
    const urlRes = await fetch(`${API}/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: job.filename, mediaType: job.file.type || "image/jpeg" }),
    });
    if (!urlRes.ok) throw new Error(`Không lấy được URL upload (HTTP ${urlRes.status})`);
    const { jobId, key, uploadUrl } = await urlRes.json();
    job.jobId = jobId;

    // 2. Upload the FULL-RES original straight to S3
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": job.file.type || "image/jpeg" },
      body: job.file,
    });
    if (!putRes.ok) throw new Error(`Upload ảnh thất bại (HTTP ${putRes.status})`);

    // 3. Trigger processing
    const procRes = await fetch(`${API}/process`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, key, filename: job.filename }),
    });
    if (!procRes.ok) throw new Error(`Không bắt đầu được xử lý (HTTP ${procRes.status})`);

    job.status = "processing";
    render();

    await pollJob(job);
  } catch (err) {
    job.status = "error";
    job.error = String(err.message || err);
    render(); updateControls();
  }
}

async function pollJob(job) {
  const maxTries = 200; // ~10 min (dense images with full thinking can be slow)
  for (let i = 0; i < maxTries; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`${API}/result/${job.jobId}`);
    if (!res.ok) continue;
    const data = await res.json();
    if (data.status === "done") {
      job.status = "done";
      job.result = data.data;
      job.boxCount = data.boxCount;
      job.holeCount = data.holeCount;
      job.lowConfidence = data.lowConfidence;
      job.crossCheckNote = data.crossCheckNote;
      job.processingMs = data.processingMs;
      render(); updateControls();
      return;
    }
    if (data.status === "error") {
      job.status = "error";
      job.error = data.error || "Model error";
      render(); updateControls();
      return;
    }
  }
  throw new Error("Hết thời gian chờ xử lý");
}

// ---- Export helpers ----
function labelsToRows(result) {
  // flatten labels -> array of objects with union of keys
  const labels = (result && result.labels) || [];
  const keys = new Set();
  for (const l of labels) {
    Object.keys(l.fields || {}).forEach(k => keys.add(k));
  }
  const cols = ["index", ...Array.from(keys)];
  const rows = labels.map(l => {
    const row = { index: l.index };
    for (const k of keys) row[k] = (l.fields && l.fields[k] != null) ? l.fields[k] : "";
    return row;
  });
  return { cols, rows };
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

function downloadCsv(jobId) {
  const job = jobs.find(j => j.id === jobId);
  if (!job || !job.result) return;
  const { cols, rows } = labelsToRows(job.result);
  const lcs = job.result.line_code_summary || {};
  const lcLines = Object.entries(lcs).map(([k, v]) => `${k},${v}`);
  const lines = [
    `box_count,${job.boxCount}`,
    "",
    "line_code,count",
    ...lcLines,
    "",
    cols.join(","),
    ...rows.map(r => cols.map(c => csvEscape(r[c])).join(",")),
  ];
  // BOM for Excel UTF-8 (Vietnamese)
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, `${job.name}.csv`);
}

function downloadJson(jobId) {
  const job = jobs.find(j => j.id === jobId);
  if (!job || !job.result) return;
  const blob = new Blob([JSON.stringify(job.result, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${job.name}.json`);
}

function uniqueSheetName(base, used) {
  // Excel sheet names: max 31 chars, no : \ / ? * [ ]
  let name = base.replace(/[:\\/?*\[\]]/g, "_").slice(0, 31) || "Sheet";
  let candidate = name, n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `_${n++}`;
    candidate = (name.slice(0, 31 - suffix.length) + suffix);
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function downloadAllExcel() {
  const done = jobs.filter(j => j.status === "done" && j.result);
  if (!done.length) return;
  const wb = XLSX.utils.book_new();
  const used = new Set();

  // collect all VC codes seen across images for summary columns
  const allCodes = new Set();
  for (const j of done) Object.keys(j.result.line_code_summary || {}).forEach(c => allCodes.add(c));
  const codeCols = Array.from(allCodes);

  // summary sheet first: image, json_name, box_count, then one column per VC code
  const summary = [["image", "json_name", "box_count", ...codeCols]];
  for (const j of done) {
    const lcs = j.result.line_code_summary || {};
    summary.push([j.filename, `${j.name}.json`, j.boxCount, ...codeCols.map(c => lcs[c] || 0)]);
  }
  const wsSum = XLSX.utils.aoa_to_sheet(summary);
  XLSX.utils.book_append_sheet(wb, wsSum, uniqueSheetName("Summary", used));

  for (const job of done) {
    const { cols, rows } = labelsToRows(job.result);
    const lcs = job.result.line_code_summary || {};
    const lcRows = Object.entries(lcs).map(([k, v]) => [k, v]);
    const aoa = [
      ["box_count", job.boxCount],
      [],
      ["line_code", "count"],
      ...lcRows,
      [],
      cols,
      ...rows.map(r => cols.map(c => r[c])),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, uniqueSheetName(job.name, used));
  }
  XLSX.writeFile(wb, "box_labels_all.xlsx");
}

// ---- Events ----
els.pickBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", e => { addFiles(e.target.files); els.fileInput.value = ""; });
els.processBtn.addEventListener("click", processAll);
els.downloadAllBtn.addEventListener("click", downloadAllExcel);
els.clearBtn.addEventListener("click", () => {
  jobs.forEach(j => URL.revokeObjectURL(j.previewUrl));
  jobs.length = 0; render(); updateControls();
});

["dragenter", "dragover"].forEach(ev =>
  els.dropzone.addEventListener(ev, e => { e.preventDefault(); els.dropzone.classList.add("drag"); }));
["dragleave", "drop"].forEach(ev =>
  els.dropzone.addEventListener(ev, e => { e.preventDefault(); els.dropzone.classList.remove("drag"); }));
els.dropzone.addEventListener("drop", e => {
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

updateControls();
