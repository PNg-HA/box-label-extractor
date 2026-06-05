// Prototype v2: detect WHITE label regions, then CLOSE (bridge text/glare gaps) and FILL
// interior holes so each label becomes a near-solid blob. Then score rectangularity:
//   extent  = area / bbox area      (how much of the bounding box it fills)
//   solidity= area / convex-hull    (how convex/parallelogram-like)
// Intact label -> high; torn/clipped -> a concave bite lowers solidity/extent.
import { readFileSync } from "fs";
import sharp from "sharp";

const file = process.argv[2];
const colArg = process.argv[3];

const oriented = sharp(readFileSync("../../" + file)).rotate();
const meta = await oriented.metadata();
const W0 = meta.width, H0 = meta.height;
let src = oriented;
let cropDesc = "full";
if (colArg != null) {
  const tileW = Math.floor(W0 / 3); const col = +colArg;
  const left = col * tileW; const w = col === 2 ? W0 - left : tileW;
  src = sharp(await oriented.extract({ left, top: 0, width: w, height: H0 }).toBuffer());
  cropDesc = "col" + col;
}

const PROC_W = 700;
const { data, info } = await src.resize({ width: PROC_W }).grayscale().raw().toBuffer({ resolveWithObject: true });
const W = info.width, H = info.height, N = W * H;

const hist = new Uint32Array(256); for (let i = 0; i < N; i++) hist[data[i]]++;
let acc = 0, TH = 200;
for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= N * 0.14) { TH = v; break; } }
TH = Math.max(140, Math.min(TH, 235));
let bright = new Uint8Array(N);
for (let i = 0; i < N; i++) bright[i] = data[i] >= TH ? 1 : 0;

// separable morphology
function morph(src, r, dilate) {
  const tmp = new Uint8Array(N), out = new Uint8Array(N);
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){let hit=dilate?0:1;for(let dx=-r;dx<=r;dx++){const xx=x+dx;if(xx<0||xx>=W)continue;const v=src[y*W+xx];if(dilate?v===1:v===0){hit=dilate?1:0;break;}}tmp[y*W+x]=hit;}
  for (let x=0;x<W;x++) for (let y=0;y<H;y++){let hit=dilate?0:1;for(let dy=-r;dy<=r;dy++){const yy=y+dy;if(yy<0||yy>=H)continue;const v=tmp[yy*W+x];if(dilate?v===1:v===0){hit=dilate?1:0;break;}}out[y*W+x]=hit;}
  return out;
}
// CLOSE = dilate then erode -> bridges black text strokes & small glare gaps inside the label
const r = Math.max(2, Math.round(W * 0.012));
bright = morph(bright, r, true);
bright = morph(bright, r, false);

// connected components + fill interior holes per blob (flood the bbox background from edges)
const label = new Int32Array(N); const stack = []; const blobs = []; let next = 0;
for (let y=0;y<H;y++) for (let x=0;x<W;x++){const idx=y*W+x;if(!bright[idx]||label[idx])continue;next++;
  let minX=x,maxX=x,minY=y,maxY=y,area=0;const pts=[];stack.length=0;stack.push(idx);label[idx]=next;
  while(stack.length){const p=stack.pop();const py=(p/W)|0,px=p%W;area++;pts.push([px,py]);
    if(px<minX)minX=px;if(px>maxX)maxX=px;if(py<minY)minY=py;if(py>maxY)maxY=py;
    if(px>0&&bright[p-1]&&!label[p-1]){label[p-1]=next;stack.push(p-1);}
    if(px<W-1&&bright[p+1]&&!label[p+1]){label[p+1]=next;stack.push(p+1);}
    if(py>0&&bright[p-W]&&!label[p-W]){label[p-W]=next;stack.push(p-W);}
    if(py<H-1&&bright[p+W]&&!label[p+W]){label[p+W]=next;stack.push(p+W);}}
  blobs.push({id:next,minX,maxX,minY,maxY,area,pts});
}

function convexHullArea(pts){if(pts.length<3)return 0;const p=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const cross=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lo=[];for(const q of p){while(lo.length>=2&&cross(lo[lo.length-2],lo[lo.length-1],q)<=0)lo.pop();lo.push(q);}
  const up=[];for(let i=p.length-1;i>=0;i--){const q=p[i];while(up.length>=2&&cross(up[up.length-2],up[up.length-1],q)<=0)up.pop();up.push(q);}
  const h=lo.slice(0,-1).concat(up.slice(0,-1));let a=0;for(let i=0;i<h.length;i++){const j=(i+1)%h.length;a+=h[i][0]*h[j][1]-h[j][0]*h[i][1];}return Math.abs(a)/2;}

// fill interior holes: blob area counting holes = bbox cells whose flood-from-border doesn't reach
function filledArea(b){
  const bw=b.maxX-b.minX+1, bh=b.maxY-b.minY+1;
  const inside=new Uint8Array(bw*bh); // 1 = belongs to this blob
  for(const [px,py] of b.pts) inside[(py-b.minY)*bw+(px-b.minX)]=1;
  // flood background from border
  const bg=new Uint8Array(bw*bh); const st=[];
  for(let x=0;x<bw;x++){for(const y of [0,bh-1]){const i=y*bw+x;if(!inside[i]&&!bg[i]){bg[i]=1;st.push(i);}}}
  for(let y=0;y<bh;y++){for(const x of [0,bw-1]){const i=y*bw+x;if(!inside[i]&&!bg[i]){bg[i]=1;st.push(i);}}}
  while(st.length){const p=st.pop();const py=(p/bw)|0,px=p%bw;
    const nb=[[px-1,py],[px+1,py],[px,py-1],[px,py+1]];
    for(const [nx,ny] of nb){if(nx<0||ny<0||nx>=bw||ny>=bh)continue;const i=ny*bw+nx;if(!inside[i]&&!bg[i]){bg[i]=1;st.push(i);}}}
  let filled=0;for(let i=0;i<bw*bh;i++) if(inside[i]||!bg[i]) filled++;
  return filled;
}

const imgArea=N;
const cands=blobs.filter(b=>b.area>imgArea*0.0025 && b.area<imgArea*0.06);
const results=[];
for(const b of cands){
  const bw=b.maxX-b.minX+1, bh=b.maxY-b.minY+1, bbox=bw*bh;
  const fa=filledArea(b);
  const extent=fa/bbox;
  const sample=b.pts.length>4000?b.pts.filter((_,i)=>i%Math.ceil(b.pts.length/4000)===0):b.pts;
  const hull=convexHullArea(sample)||b.area;
  const solidity=Math.min(1,fa/hull);
  const aspect=bw/bh;
  // rectangularity score: how box-like (combine extent & solidity)
  const rect=Math.round(Math.min(extent,solidity)*100);
  results.push({area:fa,aspect:+aspect.toFixed(2),extent:+extent.toFixed(2),solidity:+solidity.toFixed(2),rectPct:rect});
}
results.sort((a,b)=>b.area-a.area);
console.log(`${file} ${cropDesc}: TH=${TH}, closeR=${r}, label-blobs=${results.length}`);
for(const r2 of results.slice(0,40)) console.log(`  area=${r2.area}  aspect=${r2.aspect}  extent=${r2.extent}  solidity=${r2.solidity}  rect%=${r2.rectPct}  ${r2.rectPct>=65?"INTACT":"torn?"}`);
