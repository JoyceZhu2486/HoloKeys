// calibration.js — A-style keyboard geometry + drawing transplanted into B.
// - Trapezoid quad solved from F/J on home row
// - Non-uniform vertical bands (depends on Top/Bottom)
// - Fixed letter/number block across rows; peripheral keys flex to fill
// - Per-key polygons with true widths; columns align across rows
// - Full keycap drawing with labels

const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const video = document.getElementById('video');
const stage = document.getElementById('stage');

export const MIRROR_PREVIEW = true;

// ---------------- Visual keyboard definition ----------------
const ROWS = [
  { offset: 0, keys: [
    {label:'`',w:1},{label:'1',w:1},{label:'2',w:1},{label:'3',w:1},{label:'4',w:1},{label:'5',w:1},
    {label:'6',w:1},{label:'7',w:1},{label:'8',w:1},{label:'9',w:1},{label:'0',w:1},{label:'-',w:1},{label:'=',w:1},
    {label:'⌫',w:1.5},
  ]},
  { offset: 0, keys: [
    {label:'⇥',w:1.5},
    {label:'Q',w:1},{label:'W',w:1},{label:'E',w:1},{label:'R',w:1},{label:'T',w:1},
    {label:'Y',w:1},{label:'U',w:1},{label:'I',w:1},{label:'O',w:1},{label:'P',w:1},
    {label:'[',w:1},{label:']',w:1},{label:'\\',w:1},
  ]},
  { offset: 0, keys: [
    {label:'⇪',w:1.75},
    {label:'A',w:1},{label:'S',w:1},{label:'D',w:1},{label:'F',w:1},{label:'G',w:1},
    {label:'H',w:1},{label:'J',w:1},{label:'K',w:1},{label:'L',w:1},{label:';',w:1},{label:"'",w:1},
    {label:'↩',w:2.25},
  ]},
  { offset: 0, keys: [
    {label:'⇧',w:2.25},
    {label:'Z',w:1},{label:'X',w:1},{label:'C',w:1},{label:'V',w:1},
    {label:'B',w:1},{label:'N',w:1},{label:'M',w:1},{label:',',w:1},{label:'.',w:1},{label:'/',w:1},
    {label:'⇧',w:2.25},
  ]},
  { offset: 0, keys: [
    {label:'fn',w:1.2},{label:'⌃',w:1.25},{label:'⌥',w:1.5},{label:'⌘',w:1.75},
    {label:'Space',w:6.5},
    {label:'⌘',w:1.75},{label:'⌥',w:1.5},
    {label:'←',w:1},{label:'↑',w:1},{label:'↓',w:1},{label:'→',w:1},
  ]},
];

const VERTICAL_SCALE = 1.0;
const MIN_SEP_PX = 80;

// ---------------- UI parameters (sliders) ----------------
const heightSlider = document.getElementById('height');
const heightVal    = document.getElementById('heightVal');
const ratioSlider  = document.getElementById('ratio');
const ratioVal     = document.getElementById('ratioVal');

let heightScale = 0.60; // 60%
let topShrink   = 0.74; // top width / bottom width

// ---------------- Non-uniform vertical layout ----------------
let rowVBottom = [], rowVTop = [];
function recomputeRowVerticalLayout() {
  const R = ROWS.length;
  const steps = Math.max(1, R - 1);
  const ratio = Math.max(0.05, topShrink);
  const a = Math.pow(ratio, 1 / steps);
  const raw = Array.from({length:R}, (_,r)=>Math.pow(a, r));
  const sum = raw.reduce((s,v)=>s+v,0);
  rowVBottom = new Array(R); rowVTop = new Array(R);
  let acc = 0;
  for (let r=0;r<R;r++){
    const frac = raw[r] / sum;
    rowVBottom[r] = acc; acc += frac; rowVTop[r] = acc;
  }
  rowVTop[R-1] = 1.0;
}
recomputeRowVerticalLayout();

export function setHeightScale(s) {
  const v = Math.max(0.30, Math.min(3.00, Number(s) || 1.00));
  heightScale = v;
  if (heightVal) heightVal.textContent = `${Math.round(v * 100)}%`;
}
export function setTopShrink(s) {
  const v = Math.max(0.30, Math.min(1.50, Number(s) || 0.65));
  topShrink = v;
  if (ratioVal) ratioVal.textContent = v.toFixed(2);
  recomputeRowVerticalLayout();
}

// ---------------- Helpers ----------------
const vadd=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const vsub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const vmul=(a,s)=>({x:a.x*s,y:a.y*s});
const vlen=a=>Math.hypot(a.x,a.y);
const vnorm=a=>{const L=vlen(a)||1; return {x:a.x/L,y:a.y/L};};
const vrot90=a=>({x:-a.y,y:a.x});
const vdot=(a,b)=>a.x*b.x+a.y*b.y;
const normalDown=dir=>{const n=vrot90(dir); return (vdot(n,{x:0,y:1})>=0)?n:vmul(n,-1);};

function rowTotalUnits(row){ return (row.offset || 0) + row.keys.reduce((s,k)=>s+(k.w||1),0); }
function findHomeRowIndex(){
  for (let i=0;i<ROWS.length;i++){
    const L = ROWS[i].keys.map(k=>k.label);
    if (L.includes('F') && L.includes('J')) return i;
  }
  return Math.floor(ROWS.length/2);
}
function isLetterishLabel(lbl){
  return /^[A-Z]$/.test(lbl) || /^[0-9]$/.test(lbl) || [';',',','.','/'].includes(lbl);
}
function computeHomeLetterInfo() {
  const homeIndex = findHomeRowIndex();
  const row = ROWS[homeIndex];
  const total = rowTotalUnits(row);
  let cursor = row.offset || 0;
  let firstU=null, lastU=null;
  for (const k of row.keys){
    const w=k.w||1;
    if (isLetterishLabel(k.label)){
      if (firstU===null) firstU = cursor / total;
      lastU = (cursor + w) / total;
    }
    cursor += w;
  }
  return { homeIndex, u0: firstU ?? 0.2, u1: lastU ?? 0.8 };
}
const HOME_LETTER_INFO = computeHomeLetterInfo();

const LETTER_ROW_INDICES = new Set([0,1,2,3]);
const LETTER_ROW_STAGGER_COLS = { 0:-0.5, 1:0.0, 2:0.29, 3:0.76 };

function mapRectToQuad(u, v, q){
  const {LB, RB, TR, TL} = q;
  const x = LB.x*(1-u)*(1-v) + RB.x*u*(1-v) + TR.x*u*v + TL.x*(1-u)*v;
  const y = LB.y*(1-u)*(1-v) + RB.y*u*(1-v) + TR.y*u*v + TL.y*(1-u)*v;
  return {x, y};
}

function computeRowKeyIntervals(row, rowIndex, letterInfo) {
  const total = rowTotalUnits(row);

  if (!letterInfo || !LETTER_ROW_INDICES.has(rowIndex)) {
    let cur = row.offset || 0;
    return row.keys.map(k => {
      const w = k.w || 1;
      const u0 = cur / total, u1 = (cur + w) / total;
      cur += w; return { key:k, u0, u1 };
    });
  }

  const { u0: baseL0, u1: baseL1 } = letterInfo;
  const left=[], letters=[], right=[];
  let seen=false;
  for (const k of row.keys){
    const w = k.w || 1;
    if (isLetterishLabel(k.label)) { seen=true; letters.push({key:k,w}); }
    else if(!seen)                 { left.push({key:k,w}); }
    else                           { right.push({key:k,w}); }
  }

  const N = letters.length || 1;
  const colW = (baseL1 - baseL0) / N;
  const staggerCols = LETTER_ROW_STAGGER_COLS[rowIndex] || 0;
  let letterStart = baseL0 + staggerCols*colW;
  let letterEnd   = letterStart + N*colW;
  if (letterStart < 0) { letterEnd -= letterStart; letterStart = 0; }
  if (letterEnd > 1)   { const over = letterEnd - 1; letterStart -= over; letterEnd = 1; }

  const out = [];
  const leftTotal  = left.reduce((s,x)=>s+x.w,0) || 1;
  let acc=0;
  for (const it of left){
    const u0 = letterStart * (acc / leftTotal);
    const u1 = letterStart * ((acc + it.w) / leftTotal);
    out.push({ key:it.key, u0, u1 }); acc += it.w;
  }
  for (let i=0;i<N;i++){
    const it=letters[i];
    const u0 = letterStart + (letterEnd - letterStart) * (i / N);
    const u1 = letterStart + (letterEnd - letterStart) * ((i + 1) / N);
    out.push({ key:it.key, u0, u1 });
  }
  const rightTotal = right.reduce((s,x)=>s+x.w,0) || 1;
  acc=0;
  for (const it of right){
    const u0 = letterEnd + (1 - letterEnd) * (acc / rightTotal);
    const u1 = letterEnd + (1 - letterEnd) * ((acc + it.w) / rightTotal);
    out.push({ key:it.key, u0, u1 }); acc += it.w;
  }
  out.sort((a,b)=>a.u0-b.u0);
  return out;
}

// ---------------- Quad solve from F/J ----------------
export function computeQuadFromFJ(F, J){
  const sep = Math.hypot(J.x - F.x, J.y - F.y);
  if (sep < MIN_SEP_PX) return null;

  const dirTop = vnorm(vsub(J, F));
  const nDown  = normalDown(dirTop);

  const R = ROWS.length;
  const homeIdx = findHomeRowIndex();
  const homeRow = ROWS[homeIdx];

  const segsHome = computeRowKeyIntervals(homeRow, homeIdx, HOME_LETTER_INFO);
  const uCenter = (label)=>{
    const s = segsHome.find(x=>x.key.label===label);
    return s ? (s.u0 + s.u1)/2 : 0.5;
  };
  const uF = uCenter('F');
  const uJ = uCenter('J');
  const deltaU = Math.max(1e-6, uJ - uF);

  const scaleBottom = 1 / topShrink;

  const vHomeCenter = (
    (rowVBottom[homeIdx] ?? (homeIdx / R)) +
    (rowVTop[homeIdx]   ?? ((homeIdx + 1) / R))
  ) / 2;
  const tHome = 1 - vHomeCenter;
  const sHome = 1 + tHome * (scaleBottom - 1);

  const wTop = sep / (sHome * deltaU);

  const unitsHome = rowTotalUnits(homeRow);
  const oneUnit = (sHome * wTop) / unitsHome;
  const uy = oneUnit * VERTICAL_SCALE * heightScale;
  const totalH = R * uy;

  const Ctop = vsub(
    vsub(F, vmul(nDown, totalH * tHome)),
    vmul(dirTop, (uF - 0.5) * wTop * sHome)
  );

  const TL = vsub(Ctop, vmul(dirTop, wTop/2));
  const TR = vadd(Ctop, vmul(dirTop, wTop/2));
  const LB = vadd( vadd( vmul(vsub(TL, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );
  const RB = vadd( vadd( vmul(vsub(TR, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );

  return { LB, RB, TR, TL };
}

// ---------------- Cells & hit-test ----------------
export function buildKeyCells(q){
  if (!q) return [];
  const cells = [];
  const R = ROWS.length;
  for (let r=0; r<R; r++){
    const row = ROWS[r];
    const vTop = rowVTop[r]   ?? ((r+1)/R);
    const vBot = rowVBottom[r]?? (r/R);

    const segs = computeRowKeyIntervals(row, r, HOME_LETTER_INFO);
    for (const seg of segs){
      const p0 = mapRectToQuad(seg.u0, vTop, q); // TL
      const p1 = mapRectToQuad(seg.u1, vTop, q); // TR
      const p2 = mapRectToQuad(seg.u1, vBot, q); // BR
      const p3 = mapRectToQuad(seg.u0, vBot, q); // BL
      const cx = (p0.x+p1.x+p2.x+p3.x)/4, cy=(p0.y+p1.y+p2.y+p3.y)/4;
      cells.push({ label: seg.key.label, poly:[p0,p1,p2,p3], center:{x:cx,y:cy} });
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

// ---------------- Drawing ----------------
export function resizeOverlayToVideo(W,H){
  stage.style.width=W+'px'; stage.style.height=H+'px';
  video.style.width=W+'px'; video.style.height=H+'px';
  overlay.style.width=W+'px'; overlay.style.height=H+'px';
  overlay.width=W; overlay.height=H;
  octx.lineJoin='round'; octx.lineCap='round';
}
export function clearOverlay(){ octx.clearRect(0,0,overlay.width,overlay.height); }

export function drawKeyboard(q){
  if (!q) return;
  octx.save();
  octx.strokeStyle='rgba(0,128,255,0.6)';
  octx.lineWidth=2;
  octx.beginPath();
  octx.moveTo(q.TL.x, q.TL.y);
  octx.lineTo(q.TR.x, q.TR.y);
  octx.lineTo(q.RB.x, q.RB.y);
  octx.lineTo(q.LB.x, q.LB.y);
  octx.closePath();
  octx.stroke();

  for (let i=1;i<ROWS.length;i++){
    const v = rowVTop[i-1] ?? (i/ROWS.length);
    const A = mapRectToQuad(0, v, q);
    const B = mapRectToQuad(1, v, q);
    octx.beginPath(); octx.moveTo(A.x,A.y); octx.lineTo(B.x,B.y); octx.stroke();
  }
  octx.restore();
}

export function drawKeycaps(q, { outline='rgba(0,128,255,0.6)', lineWidth=1.25, fill='rgba(0,128,255,0.14)', showLabels=true } = {}) {
  if (!q) return;
  const cells = buildKeyCells(q);
  octx.save();
  octx.lineWidth = lineWidth;
  octx.strokeStyle = outline;
  octx.fillStyle = fill;

  for (const c of cells) {
    const p=c.poly;
    octx.beginPath(); octx.moveTo(p[0].x,p[0].y);
    for (let i=1;i<p.length;i++) octx.lineTo(p[i].x,p[i].y);
    octx.closePath();
    octx.fill(); octx.stroke();
  }

  if (showLabels) {
    octx.fillStyle = '#0a0a0a';
    const R = ROWS.length, homeRowIdx = findHomeRowIndex();
    const vTop = rowVTop[homeRowIdx] ?? ((homeRowIdx+1)/R);
    const vBot = rowVBottom[homeRowIdx] ?? (homeRowIdx/R);
    const pTop = mapRectToQuad(0.5, vTop, q);
    const pBot = mapRectToQuad(0.5, vBot, q);
    const keyH = Math.hypot(pTop.x - pBot.x, pTop.y - pBot.y);
    const fontPx = Math.max(10, Math.round(keyH * 0.64));
    octx.font = `${fontPx}px system-ui`;
    octx.textAlign='center'; octx.textBaseline='middle';

    for (const c of cells) octx.fillText(String(c.label), c.center.x, c.center.y);
  }
  octx.restore();
}

export function drawFingerKeyLabels(tips, q){
  if (!q || !tips?.length) return;
  const cells = buildKeyCells(q); if (!cells.length) return;
  octx.save();
  for (const t of tips){
    const hit=findKeyAtPoint(cells,{x:t.x,y:t.y});
    const text=hit?`${t.tag||t.finger}: ${hit.label}`:`${t.tag||t.finger}: —`;
    const padX=6, padY=3;
    octx.font='12px system-ui';
    const m=octx.measureText(text);
    const w=Math.ceil(m.width)+padX*2, h=18, r=8;
    const left=Math.round(t.x-w/2), top=Math.round(t.y-12-h);
    octx.fillStyle='rgba(255,255,255,0.85)';
    octx.beginPath();
    octx.moveTo(left + r, top);
    octx.arcTo(left + w, top, left + w, top + h, r);
    octx.arcTo(left + w, top + h, left, top + h, r);
    octx.arcTo(left, top + h, left, top, r);
    octx.arcTo(left, top, left + w, top, r);
    octx.closePath();
    octx.fill();
    octx.strokeStyle='rgba(0,0,0,0.25)'; octx.stroke();
    octx.fillStyle='#111'; octx.textAlign='center'; octx.textBaseline='middle';
    octx.fillText(text, left + w/2, top + h/2);
  }
  octx.restore();
}
