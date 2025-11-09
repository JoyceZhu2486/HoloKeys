// calibration.js — Version A slider behavior cloned in B (height & top/bottom)
// Also keeps A’s F/J-based geometry and letter-span alignment.

const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const statusEl = document.getElementById('status');
const video = document.getElementById('video');
const stage = document.getElementById('stage');

const showHandsChk = document.getElementById('chkShowHands');
const showDebugChk = document.getElementById('chkShowDebug');

const heightSlider = document.getElementById('height');
const heightVal    = document.getElementById('heightVal');
const ratioSlider  = document.getElementById('ratio');
const ratioVal     = document.getElementById('ratioVal');

export const MIRROR_PREVIEW = true;

// ---------- Layout (same as A) ----------
const ROWS = [
  { offset:0, keys:[{label:'`',w:1},{label:'1',w:1},{label:'2',w:1},{label:'3',w:1},{label:'4',w:1},{label:'5',w:1},{label:'6',w:1},{label:'7',w:1},{label:'8',w:1},{label:'9',w:1},{label:'0',w:1},{label:'-',w:1},{label:'=',w:1},{label:'⌫',w:1.5}]},
  { offset:0, keys:[{label:'⇥',w:1.5},{label:'Q',w:1},{label:'W',w:1},{label:'E',w:1},{label:'R',w:1},{label:'T',w:1},{label:'Y',w:1},{label:'U',w:1},{label:'I',w:1},{label:'O',w:1},{label:'P',w:1},{label:'[',w:1},{label:']',w:1},{label:'\\',w:1}]},
  { offset:0, keys:[{label:'⇬',w:1.75},{label:'A',w:1},{label:'S',w:1},{label:'D',w:1},{label:'F',w:1},{label:'G',w:1},{label:'H',w:1},{label:'J',w:1},{label:'K',w:1},{label:'L',w:1},{label:';',w:1},{label:"'",w:1},{label:'↩',w:1.75}]},
  { offset:0, keys:[{label:'⇧',w:2.25},{label:'Z',w:1},{label:'X',w:1},{label:'C',w:1},{label:'V',w:1},{label:'B',w:1},{label:'N',w:1},{label:'M',w:1},{label:',',w:1},{label:'.',w:1},{label:'/',w:1},{label:'⇧',w:2.25}]},
  { offset:0, keys:[{label:'Ctrl',w:1.5},{label:'Alt',w:1.25},{label:'Cmd',w:1.25},{label:'Space',w:5.5},{label:'Cmd',w:1.25},{label:'Alt',w:1.25},{label:'Ctrl',w:1.5}]},
];

const VERTICAL_SCALE = 1.0;
const MIN_SEP_PX = 80;

// A’s defaults
let heightScale = 0.60;  // shown as 60%
let topShrink   = 0.74;  // width_top / width_bottom

// Non-uniform row bands (dependent on topShrink)
let rowVBottom = [], rowVTop = [];
function recomputeRowVerticalLayout() {
  const R = ROWS.length;
  const steps = Math.max(1, R - 1);
  const a = Math.pow(Math.max(0.05, topShrink), 1 / steps);
  const raw = Array.from({length:R}, (_,r)=>Math.pow(a,r));
  const sum = raw.reduce((s,v)=>s+v,0);
  rowVBottom = new Array(R);
  rowVTop = new Array(R);
  let acc = 0;
  for (let r=0;r<R;r++){
    const frac = raw[r] / sum;
    rowVBottom[r] = acc; acc += frac; rowVTop[r] = acc;
  }
  rowVTop[R-1] = 1.0;
}
recomputeRowVerticalLayout();

// ---- math helpers ----
const lerp=(a,b,t)=>a+(b-a)*t;
const vadd=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const vsub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const vmul=(a,s)=>({x:a.x*s,y:a.y*s});
const vlen=a=>Math.hypot(a.x,a.y);
const vnorm=a=>{const L=vlen(a)||1; return {x:a.x/L,y:a.y/L};};
const vrot90=a=>({x:-a.y,y:a.x});
const vdot=(a,b)=>a.x*b.x+a.y*b.y;
const normalDown=dir=>{const n=vrot90(dir); return (vdot(n,{x:0,y:1})>=0)?n:vmul(n,-1);};

function mapRectToQuad(u, v, q) {
  const { p1:TL, p2:TR, p3:BR, p4:BL } = q;
  const top = { x: TL.x + (TR.x - TL.x) * u, y: TL.y + (TR.y - TL.y) * u };
  const bot = { x: BL.x + (BR.x - BL.x) * u, y: BL.y + (BR.y - BL.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}

function rowTotalUnits(row){ return (row.offset||0) + row.keys.reduce((s,k)=>s+(k.w||1),0); }
function findHomeRowIndex(){
  for (let i=0;i<ROWS.length;i++){
    const labels=ROWS[i].keys.map(k=>k.label);
    if (labels.includes('F') && labels.includes('J')) return i;
  }
  return Math.floor(ROWS.length/2);
}
const LETTER_ROW_INDICES = new Set([0,1,2,3]);
function isLetterishLabel(lbl){
  return /^[A-Z]$/.test(lbl) || /^[0-9]$/.test(lbl) || [';',',','.','/'].includes(lbl);
}
function getHomeLetterInfo(){
  const rowIndex = findHomeRowIndex();
  const row = ROWS[rowIndex];
  const total = rowTotalUnits(row);
  let cursor=row.offset||0, uF=0.5, uJ=0.5, first=null, last=null;
  for (const k of row.keys){
    const w=k.w||1; const a=cursor/total, b=(cursor+w)/total;
    if (isLetterishLabel(k.label)){ if(first===null) first=a; last=b; }
    if (k.label==='F') uF=(a+b)/2;
    if (k.label==='J') uJ=(a+b)/2;
    cursor+=w;
  }
  return { rowIndex, uF, uJ, u0:(first??0.2), u1:(last??0.8) };
}

// align rows to home-row letter span
function computeRowKeyIntervals(row, rowIndex, letterInfo) {
  const total = rowTotalUnits(row);
  if (!letterInfo || !LETTER_ROW_INDICES.has(rowIndex)) {
    let cur=row.offset||0;
    return row.keys.map(k=>{ const w=k.w||1; const u0=cur/total, u1=(cur+w)/total; cur+=w; return {key:k,u0,u1}; });
  }
  const { u0:baseL0, u1:baseL1 } = letterInfo;

  const left=[], letters=[], right=[];
  let seen=false;
  for (const k of row.keys){
    const w=k.w||1, L=isLetterishLabel(k.label);
    if (L){ seen=true; letters.push({key:k,w}); }
    else if(!seen){ left.push({key:k,w}); }
    else { right.push({key:k,w}); }
  }

  const N = Math.max(1, letters.length);
  const colW = (baseL1 - baseL0)/N;

  // (A’s version here uses fixed “stagger” set; we keep the direct lock behavior)
  let letterStart = baseL0, letterEnd = baseL1;

  const intervals=[];
  const sumW = arr=>arr.reduce((s,a)=>s+(a.w||1),0)||1;

  // left → [0, letterStart)
  let acc=0, leftTotal=sumW(left);
  for (const it of left){
    const u0 = letterStart*(acc/leftTotal);
    const u1 = letterStart*((acc+it.w)/leftTotal);
    intervals.push({key:it.key,u0,u1}); acc+=it.w;
  }
  // letters → evenly spaced in [letterStart, letterEnd)
  for (let i=0;i<N;i++){
    const it=letters[i];
    const u0 = letterStart + (letterEnd-letterStart)*(i/N);
    const u1 = letterStart + (letterEnd-letterStart)*((i+1)/N);
    intervals.push({key:it.key,u0,u1});
  }
  // right → [letterEnd, 1]
  acc=0; const rightTotal=sumW(right);
  for (const it of right){
    const u0 = letterEnd + (1-letterEnd)*(acc/rightTotal);
    const u1 = letterEnd + (1-letterEnd)*((acc+it.w)/rightTotal);
    intervals.push({key:it.key,u0,u1}); acc+=it.w;
  }
  intervals.sort((A,B)=>A.u0-B.u0);
  return intervals;
}

// --- DEBUG: draw X marks at the averaged F and J (exported for app.js) ---
export function drawDebugFJ() {
  if (!showDebugChk?.checked) return;

  const hasF = calibState?.F?.count > 0;
  const hasJ = calibState?.J?.count > 0;
  if (!hasF || !hasJ) return;

  const F = { x: calibState.F.x / calibState.F.count, y: calibState.F.y / calibState.F.count };
  const J = { x: calibState.J.x / calibState.J.count, y: calibState.J.y / calibState.J.count };

  octx.save();
  octx.strokeStyle = 'rgba(0,255,255,0.95)';
  octx.lineWidth = 2;

  const drawX = (pt, r = 6) => {
    octx.beginPath();
    octx.moveTo(pt.x - r, pt.y - r); octx.lineTo(pt.x + r, pt.y + r);
    octx.moveTo(pt.x + r, pt.y - r); octx.lineTo(pt.x - r, pt.y + r);
    octx.stroke();
  };

  drawX(F);
  drawX(J);
  octx.restore();
}


function computeQuadFromFJ(F, J){
  const sep = Math.hypot(J.x - F.x, J.y - F.y);
  if (sep < MIN_SEP_PX) return null;

  // Direction along the *top* edge (left→right), and the "down" normal
  const dirTop = vnorm(vsub(J, F));
  const nDown  = normalDown(dirTop);

  // Home-row info (we align F/J centers on the home row)
  const info    = getHomeLetterInfo();
  const homeIdx = info.rowIndex;

  // Vertical center of the home row using the non-uniform row bands
  const vHomeCenter = (
    (rowVBottom[homeIdx] ?? (homeIdx / ROWS.length)) +
    (rowVTop[homeIdx]   ?? ((homeIdx + 1) / ROWS.length))
  ) / 2;

  // User slider: topShrink = (top width)/(bottom width)  →  bottom scale
  const scaleBottom = 1 / topShrink;  // >1 widens the bottom relative to top

  // How far down (0 at top, 1 at bottom) the home row center sits
  const tHome = 1 - vHomeCenter;

  // Horizontal scale at the home row due to the trapezoid
  const sHome = 1 + tHome * (scaleBottom - 1);

  // F/J horizontal separation as a fraction of the home row’s width
  const deltaU = Math.max(1e-6, info.uJ - info.uF);

  // Solve top width so that the home-row F↔J maps to the measured separation
  const wTop = sep / (sHome * deltaU);

  // Vertical pitch from the “one unit” width on the home row
  const unitsHome   = rowTotalUnits(ROWS[homeIdx]);
  const oneUnitHome = (sHome * wTop) / unitsHome;
  const uy          = oneUnitHome * VERTICAL_SCALE * heightScale;
  const totalH      = ROWS.length * uy;

  // Place top-edge center so the *home-row* F/J land exactly on the fingertips
  const Ctop = vsub(
    vsub(F, vmul(nDown, totalH * tHome)),                  // shift down to home row
    vmul(dirTop, (info.uF - 0.5) * wTop * sHome)           // center so F/J align
  );

  // Top edge endpoints
  const TL = vsub(Ctop, vmul(dirTop, wTop / 2));
  const TR = vadd(Ctop, vmul(dirTop, wTop / 2));

  // Bottom edge endpoints (top edge scaled about Ctop, then pushed down)
  const BL = vadd( vadd( vmul(vsub(TL, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );
  const BR = vadd( vadd( vmul(vsub(TR, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );

  // Keep the same naming B already uses elsewhere: p1..p4 (TL, TR, BR, BL)
  return { p1: TL, p2: TR, p3: BR, p4: BL };
}


// ---- cells + hit test ----
export function buildKeyCells(q){
  if (!q) return [];
  const info = getHomeLetterInfo();
  const cells=[];
  for (let r=0;r<ROWS.length;r++){
    const row=ROWS[r];
    const vTop = rowVTop[r]   ?? ((r+1)/ROWS.length);
    const vBot = rowVBottom[r]?? (r/ROWS.length);
    const segs = computeRowKeyIntervals(row, r, info);
    for (const seg of segs){
      const p0=mapRectToQuad(seg.u0, vTop, q);
      const p1=mapRectToQuad(seg.u1, vTop, q);
      const p2=mapRectToQuad(seg.u1, vBot, q);
      const p3=mapRectToQuad(seg.u0, vBot, q);
      const cx=(p0.x+p1.x+p2.x+p3.x)/4, cy=(p0.y+p1.y+p2.y+p3.y)/4;
      cells.push({ label:seg.key.label, poly:[p0,p1,p2,p3], center:{x:cx,y:cy} });
    }
  }
  return cells;
}
function pointInConvex(pt, poly){
  let pos=false, neg=false;
  for (let i=0;i<poly.length;i++){
    const a=poly[i], b=poly[(i+1)%poly.length];
    const cross=(b.x-a.x)*(pt.y-a.y) - (b.y-a.y)*(pt.x-a.x);
    if (cross<0) neg=true; if (cross>0) pos=true;
    if (pos&&neg) return false;
  }
  return true;
}
export function findKeyAtPoint(cells, pt){
  for (const c of cells) if (pointInConvex(pt, c.poly)) return c;
  return null;
}

// ---- overlay plumbing ----
export function resizeOverlayToVideo(W,H){
  stage.style.width=W+'px'; stage.style.height=H+'px';
  video.style.width=W+'px'; video.style.height=H+'px';
  overlay.style.width=W+'px'; overlay.style.height=H+'px';
  overlay.width=W; overlay.height=H;
  octx.lineJoin='round'; octx.lineCap='round';
}
export function clearOverlay(){ octx.clearRect(0,0,overlay.width,overlay.height); }

export function drawKeyboard(q,{color='cyan',line=2}={}){
  if (!q) return;
  const {p1,p2,p3,p4}=q;
  octx.save(); octx.strokeStyle=color; octx.lineWidth=line;
  octx.beginPath(); octx.moveTo(p1.x,p1.y); octx.lineTo(p2.x,p2.y); octx.lineTo(p3.x,p3.y); octx.lineTo(p4.x,p4.y); octx.closePath(); octx.stroke();
  for (let i=1;i<ROWS.length;i++){
    const v=rowVTop[i-1] ?? (i/ROWS.length);
    const A=mapRectToQuad(0,v,q), B=mapRectToQuad(1,v,q);
    octx.beginPath(); octx.moveTo(A.x,A.y); octx.lineTo(B.x,B.y); octx.stroke();
  }
  octx.restore();
}
function drawPill(text,x,y){
  octx.save();
  octx.font='12px system-ui';
  const padX=6, padY=3;
  const m=octx.measureText(text);
  const w=Math.ceil(m.width)+padX*2, h=16+(padY-3), r=8;
  const left=Math.round(x-w/2), top=Math.round(y-h);
  octx.fillStyle='rgba(0,0,0,0.75)';
  octx.beginPath(); octx.roundRect(left,top,w,h,r); octx.fill();
  octx.fillStyle='white'; octx.textAlign='center'; octx.textBaseline='middle';
  octx.fillText(text, x, y - h/2 - 1);
  octx.restore();
}
export function drawFingerKeyLabels(tips,q){
  if (!q || !tips?.length) return;
  const cells = buildKeyCells(q); if (!cells.length) return;
  for (const t of tips){
    const hit=findKeyAtPoint(cells,{x:t.x,y:t.y});
    const lbl=hit?`${t.tag||t.finger}: ${hit.label}`:`${t.tag||t.finger}: —`;
    drawPill(lbl, t.x, t.y-12);
  }
}

// ---- Calibration state (averaged F/J from two Index fingertips) ----
export const calibState = {
  active:false, frozen:false, startMs:0,
  F:{x:0,y:0,count:0}, J:{x:0,y:0,count:0},
  quad:null,
};

// You already have strict F/J selection in your fingertips → app; leave as-is.
// Here we only consume averaged F/J to refresh the quad when sliders change.
function currentAveragedFJ(){
  if (!calibState.F.count || !calibState.J.count) return null;
  return {
    F: { x: calibState.F.x / calibState.F.count, y: calibState.F.y / calibState.F.count },
    J: { x: calibState.J.x / calibState.J.count, y: calibState.J.y / calibState.J.count },
  };
}

// Recompute the keyboard quad from the current F/J averages (used during calibration)
export function computeQuadFromAverages() {
  if (!calibState?.F?.count || !calibState?.J?.count) return null;
  const F = { x: calibState.F.x / calibState.F.count, y: calibState.F.y / calibState.F.count };
  const J = { x: calibState.J.x / calibState.J.count, y: calibState.J.y / calibState.J.count };
  const q = computeQuadFromFJ(F, J);
  if (q) calibState.quad = q;
  return q;
}

// === A’s slider functions ===
export function setHeightScale(s){
  const v = Math.max(0.30, Math.min(3.00, Number(s) || 1.00));
  heightScale = v;
  if (heightVal) heightVal.textContent = `${Math.round(v * 100)}%`;
  const fj = currentAveragedFJ();
  if (fj) calibState.quad = computeQuadFromFJ(fj.F, fj.J);
}

export function setTopShrink(s){
  const v = Math.max(0.30, Math.min(1.50, Number(s) || 0.65));
  topShrink = v;
  if (ratioVal) ratioVal.textContent = v.toFixed(2);

  // A: vertical layout depends on topShrink
  recomputeRowVerticalLayout();

  const fj = currentAveragedFJ();
  if (fj) calibState.quad = computeQuadFromFJ(fj.F, fj.J);
}

// Draw every key polygon (same per-key rendering style as A)
export function drawKeycaps(q, { outline = 'rgba(0,255,255,0.9)', lineWidth = 1.5, fill = 'rgba(0,0,0,0.25)', showLabels = true } = {}) {
  if (!q) return;
  const cells = buildKeyCells(q);
  octx.save();
  octx.lineWidth = lineWidth;
  octx.strokeStyle = outline;
  octx.fillStyle = fill;

  // draw polygons
  for (const c of cells) {
    const poly = c.poly;
    octx.beginPath();
    octx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) octx.lineTo(poly[i].x, poly[i].y);
    octx.closePath();
    octx.fill();
    octx.stroke();
  }

  // labels on top
  if (showLabels) {
    octx.fillStyle = 'white';
    octx.font = '11px system-ui';
    octx.textAlign = 'center';
    octx.textBaseline = 'middle';
    for (const c of cells) {
      // keep labels minimal like A: skip wide modifiers if you want less clutter
      const lbl = String(c.label);
      // optional: small offsets for arrows/icons if needed
      octx.fillText(lbl, c.center.x, c.center.y);
    }
  }

  octx.restore();
}
