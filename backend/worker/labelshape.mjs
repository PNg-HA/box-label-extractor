import sharp from "sharp";

/*
 Detect INTACT white label regions in a column tile via pure image processing, so we can keep
 OCR text only from whole labels and ignore torn / partial / secondary slips.

 Method: threshold the brightest pixels (white labels on brown cardboard) -> morphological
 CLOSE to bridge the black text strokes & glare gaps -> fill interior holes -> for each blob
 measure rectangularity = min(extent, solidity):
   extent   = filled area / bounding-box area
   solidity = filled area / convex-hull area
 An intact rectangular/parallelogram label scores high (~>=0.65); a torn label has a concave
 "bite" that lowers it. Returns normalized boxes (0..1) of regions that pass the threshold.
*/

const PROC_W = 700;
const BRIGHT_PCT = 0.14;        // brightest share treated as "white"
const RECT_MIN = 0.65;          // intactness threshold
const ASPECT_LO = 0.25, ASPECT_HI = 3.0;

function morph(src, W, H, r, dilate) {
  const N = W * H, tmp = new Uint8Array(N), out = new Uint8Array(N);
  for (let y=0;y<H;y++) for (let x=0;x<W;x++){let hit=dilate?0:1;for(let dx=-r;dx<=r;dx++){const xx=x+dx;if(xx<0||xx>=W)continue;const v=src[y*W+xx];if(dilate?v===1:v===0){hit=dilate?1:0;break;}}tmp[y*W+x]=hit;}
  for (let x=0;x<W;x++) for (let y=0;y<H;y++){let hit=dilate?0:1;for(let dy=-r;dy<=r;dy++){const yy=y+dy;if(yy<0||yy>=H)continue;const v=tmp[yy*W+x];if(dilate?v===1:v===0){hit=dilate?1:0;break;}}out[y*W+x]=hit;}
  return out;
}
function convexHullArea(pts){if(pts.length<3)return 0;const p=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
  const lo=[];for(const q of p){while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],q)<=0)lo.pop();lo.push(q);}
  const up=[];for(let i=p.length-1;i>=0;i--){const q=p[i];while(up.length>=2&&cr(up[up.length-2],up[up.length-1],q)<=0)up.pop();up.push(q);}
  const h=lo.slice(0,-1).concat(up.slice(0,-1));let a=0;for(let i=0;i<h.length;i++){const j=(i+1)%h.length;a+=h[i][0]*h[j][1]-h[j][0]*h[i][1];}return Math.abs(a)/2;}

// returns { regions: [{x0,y0,x1,y1,rect}], ok: bool } with coords normalized 0..1
export async function intactLabelRegions(tileBuffer) {
  try {
    const { data, info } = await sharp(tileBuffer, { failOn: "none" })
      .resize({ width: PROC_W }).grayscale().raw().toBuffer({ resolveWithObject: true });
    const W = info.width, H = info.height, N = W * H;

    const hist = new Uint32Array(256); for (let i=0;i<N;i++) hist[data[i]]++;
    let acc=0, TH=200; for(let v=255;v>=0;v--){acc+=hist[v];if(acc>=N*BRIGHT_PCT){TH=v;break;}}
    TH = Math.max(140, Math.min(TH, 235));
    let bright = new Uint8Array(N); for(let i=0;i<N;i++) bright[i]=data[i]>=TH?1:0;

    const r = Math.max(2, Math.round(W * 0.012));
    bright = morph(bright, W, H, r, true);
    bright = morph(bright, W, H, r, false);

    const label = new Int32Array(N); const stack=[]; const blobs=[]; let next=0;
    for(let y=0;y<H;y++) for(let x=0;x<W;x++){const idx=y*W+x;if(!bright[idx]||label[idx])continue;next++;
      let minX=x,maxX=x,minY=y,maxY=y;const pts=[];stack.length=0;stack.push(idx);label[idx]=next;
      while(stack.length){const p=stack.pop();const py=(p/W)|0,px=p%W;pts.push([px,py]);
        if(px<minX)minX=px;if(px>maxX)maxX=px;if(py<minY)minY=py;if(py>maxY)maxY=py;
        if(px>0&&bright[p-1]&&!label[p-1]){label[p-1]=next;stack.push(p-1);}
        if(px<W-1&&bright[p+1]&&!label[p+1]){label[p+1]=next;stack.push(p+1);}
        if(py>0&&bright[p-W]&&!label[p-W]){label[p-W]=next;stack.push(p-W);}
        if(py<H-1&&bright[p+W]&&!label[p+W]){label[p+W]=next;stack.push(p+W);}}
      blobs.push({minX,maxX,minY,maxY,pts});
    }

    const imgArea = N;
    const regions = [];
    for (const b of blobs) {
      const bw=b.maxX-b.minX+1, bh=b.maxY-b.minY+1, bbox=bw*bh;
      if (bbox < imgArea*0.0025 || bbox > imgArea*0.06) continue;   // label-sized only
      const aspect = bw/bh;
      if (aspect < ASPECT_LO || aspect > ASPECT_HI) continue;        // drop slivers/merged streaks
      // fill interior holes
      const inside=new Uint8Array(bw*bh);
      for(const [px,py] of b.pts) inside[(py-b.minY)*bw+(px-b.minX)]=1;
      const bg=new Uint8Array(bw*bh); const st=[];
      for(let x=0;x<bw;x++) for(const y of [0,bh-1]){const i=y*bw+x;if(!inside[i]&&!bg[i]){bg[i]=1;st.push(i);}}
      for(let y=0;y<bh;y++) for(const x of [0,bw-1]){const i=y*bw+x;if(!inside[i]&&!bg[i]){bg[i]=1;st.push(i);}}
      while(st.length){const p=st.pop();const py=(p/bw)|0,px=p%bw;const nb=[[px-1,py],[px+1,py],[px,py-1],[px,py+1]];
        for(const [nx,ny] of nb){if(nx<0||ny<0||nx>=bw||ny>=bh)continue;const i=ny*bw+nx;if(!inside[i]&&!bg[i]){bg[i]=1;st.push(i);}}}
      let fa=0; for(let i=0;i<bw*bh;i++) if(inside[i]||!bg[i]) fa++;
      const extent = fa/bbox;
      const sample = b.pts.length>4000 ? b.pts.filter((_,i)=>i%Math.ceil(b.pts.length/4000)===0) : b.pts;
      const hull = convexHullArea(sample) || fa;
      const solidity = Math.min(1, fa/hull);
      const rect = Math.min(extent, solidity);
      if (rect >= RECT_MIN) {
        regions.push({ x0:b.minX/W, y0:b.minY/H, x1:(b.maxX+1)/W, y1:(b.maxY+1)/H, rect:+rect.toFixed(2) });
      }
    }
    return { regions, ok: regions.length > 0 };
  } catch (e) {
    return { regions: [], ok: false };
  }
}

// keep only OCR lines whose center lies inside an intact-label region (with small padding)
export function filterLinesByRegions(linesWithGeom, regions, pad = 0.01) {
  if (!regions || !regions.length) return linesWithGeom; // no reliable regions -> don't filter
  return linesWithGeom.filter(l => {
    const cx = l.left + l.width / 2, cy = l.top + l.height / 2;
    return regions.some(r => cx >= r.x0 - pad && cx <= r.x1 + pad && cy >= r.y0 - pad && cy <= r.y1 + pad);
  });
}
