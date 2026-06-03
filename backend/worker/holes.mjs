import sharp from "sharp";

/*
 REFERENCE-ONLY cross-check (no ML). Detects dark, roughly-round viewing holes:
  - adaptive threshold from a per-image brightness percentile (handles light & dark photos),
  - morphological CLOSING to bridge bright objects (flowers/plastic) sitting inside a hole,
  - circularity test via radial-distance consistency (true round-shape detection),
  - uniform-size band from the median blob (holes are similar within one image).
 Tuned config tracks the true box count well (abs error ~11 over the eval set), but it is
 still a noisy reference and is used ONLY to flag possible under-counts — never to change the count.
*/

const CFG = { procW: 900, pct: 0.16, closeFrac: 0.004, cvMax: 0.45, sizeLo: 0.4, sizeHi: 2.6 };

function morph(src, W, H, r, dilate) {
  const tmp = new Uint8Array(W * H), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let hit = dilate ? 0 : 1;
    for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; const v = src[y*W+xx]; if (dilate ? v === 1 : v === 0) { hit = dilate ? 1 : 0; break; } }
    tmp[y*W+x] = hit;
  }
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    let hit = dilate ? 0 : 1;
    for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; const v = tmp[yy*W+x]; if (dilate ? v === 1 : v === 0) { hit = dilate ? 1 : 0; break; } }
    out[y*W+x] = hit;
  }
  return out;
}

export async function detectHoles(buffer) {
  try {
    const oriented = sharp(buffer, { failOn: "none" }).rotate();
    const meta = await oriented.metadata();
    const scaleW = Math.min(CFG.procW, meta.width || CFG.procW);
    const { data, info } = await oriented.resize({ width: scaleW }).grayscale().blur(1).raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, N = W * H;

    const hist = new Uint32Array(256);
    for (let i = 0; i < N; i++) hist[data[i]]++;
    let acc = 0, TH = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= N * CFG.pct) { TH = v; break; } }
    TH = Math.max(30, Math.min(TH, 120));

    let dark = new Uint8Array(N);
    for (let i = 0; i < N; i++) dark[i] = data[i] < TH ? 1 : 0;
    const r = Math.max(1, Math.round(W * CFG.closeFrac));
    dark = morph(dark, W, H, r, true);
    dark = morph(dark, W, H, r, false);

    const label = new Int32Array(N);
    const stack = [];
    const blobs = [];
    let next = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!dark[idx] || label[idx]) continue;
      next++;
      let minX = x, maxX = x, minY = y, maxY = y, area = 0, sx = 0, sy = 0;
      stack.length = 0; stack.push(idx); label[idx] = next; const pts = [];
      while (stack.length) {
        const p = stack.pop(); const py = (p / W) | 0, px = p % W;
        area++; sx += px; sy += py; pts.push(p);
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (py < minY) minY = py; if (py > maxY) maxY = py;
        if (px > 0   && dark[p-1] && !label[p-1]) { label[p-1] = next; stack.push(p-1); }
        if (px < W-1 && dark[p+1] && !label[p+1]) { label[p+1] = next; stack.push(p+1); }
        if (py > 0   && dark[p-W] && !label[p-W]) { label[p-W] = next; stack.push(p-W); }
        if (py < H-1 && dark[p+W] && !label[p+W]) { label[p+W] = next; stack.push(p+W); }
      }
      blobs.push({ minX, maxX, minY, maxY, area, cx: sx/area, cy: sy/area, pts });
    }

    const imgArea = N;
    const cand = blobs.filter(b => b.area > imgArea * 0.0005 && b.area < imgArea * 0.04);
    if (!cand.length) return { holes: 0, xs: [] };
    const areas = cand.map(b => b.area).sort((a, b) => a - b);
    const medA = areas[Math.floor(areas.length / 2)];

    const xs = [];
    for (const b of cand) {
      const bw = b.maxX - b.minX + 1, bh = b.maxY - b.minY + 1, aspect = bw / bh;
      if (aspect < 0.55 || aspect > 1.8) continue;
      if (b.area < medA * CFG.sizeLo || b.area > medA * CFG.sizeHi) continue;
      let rs = [], cnt = 0;
      for (const p of b.pts) {
        const py = (p / W) | 0, px = p % W;
        const boundary = (px===0||px===W-1||py===0||py===H-1) || !dark[p-1] || !dark[p+1] || !dark[p-W] || !dark[p+W];
        if (!boundary) continue;
        rs.push(Math.hypot(px - b.cx, py - b.cy)); cnt++;
      }
      if (cnt < 8) continue;
      const meanR = rs.reduce((a, c) => a + c, 0) / cnt;
      const cv = Math.sqrt(rs.reduce((a, c) => a + (c - meanR) * (c - meanR), 0) / cnt) / meanR;
      if (cv > CFG.cvMax) continue;
      xs.push(b.cx / W);  // X centroid as a fraction of width
    }
    xs.sort((a, b) => a - b);
    return { holes: xs.length, xs };
  } catch (e) {
    return null; // never break the main pipeline
  }
}

export async function countHoles(buffer) {
  const r = await detectHoles(buffer);
  return r ? r.holes : null;
}

// 1D k-means on hole X-fractions -> column cut boundaries (fractions of width).
// Returns null if there isn't enough signal to trust the clustering.
export function columnCutsFromHoles(xs, k) {
  if (!xs || xs.length < k * 3) return null;  // need a few holes per column to be reliable
  let centers = [];
  for (let i = 0; i < k; i++) centers.push(xs[Math.floor((i + 0.5) / k * xs.length)]);
  for (let iter = 0; iter < 40; iter++) {
    const groups = centers.map(() => []);
    for (const x of xs) {
      let bi = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = Math.abs(x - c); if (d < bd) { bd = d; bi = i; } });
      groups[bi].push(x);
    }
    if (groups.some(g => g.length === 0)) return null;  // degenerate clustering
    const nc = groups.map((g, i) => g.reduce((a, b) => a + b, 0) / g.length);
    if (nc.every((c, i) => Math.abs(c - centers[i]) < 1e-4)) { centers = nc; break; }
    centers = nc;
  }
  centers.sort((a, b) => a - b);
  // sanity: centers should be reasonably spread, not bunched
  const cuts = [];
  for (let i = 1; i < centers.length; i++) cuts.push((centers[i - 1] + centers[i]) / 2);
  // reject if any two centers are too close (clustering collapsed)
  for (let i = 1; i < centers.length; i++) if (centers[i] - centers[i - 1] < 0.08) return null;
  return cuts;
}
