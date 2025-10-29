// calibration.js — F/J solve → keyboard quad, draw overlay, hit-test
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');
const statusEl = document.getElementById('status');

const showHandsChk = document.getElementById('chkShowHands');
const showDebugChk = document.getElementById('chkShowDebug');
const heightSlider = document.getElementById('height');
const heightVal    = document.getElementById('heightVal');
const ratioSlider  = document.getElementById('ratio');
const ratioVal     = document.getElementById('ratioVal');

export const MIRROR_PREVIEW = true;
const CALIBRATION_SECONDS = 10;
const MIN_SEP_PX = 80;

// Visual keyboard rows (ported)
const ROWS = [
  { offset:0, keys:[ {label:'`',w:1},{label:'1',w:1},{label:'2',w:1},{label:'3',w:1},{label:'4',w:1},{label:'5',w:1},
    {label:'6',w:1},{label:'7',w:1},{label:'8',w:1},{label:'9',w:1},{label:'0',w:1},{label:'-',w:1},{label:'=',w:1},{label:'⌫',w:1.5} ]},
  { offset:0, keys:[ {label:'⇥',w:1.5},{label:'Q',w:1},{label:'W',w:1},{label:'E',w:1},{label:'R',w:1},{label:'T',w:1},
    {label:'Y',w:1},{label:'U',w:1},{label:'I',w:1},{label:'O',w:1},{label:'P',w:1},{label:'[',w:1},{label:']',w:1},{label:'\\',w:1} ]},
  { offset:0, keys:[ {label:'⇪',w:1.75},{label:'A',w:1},{label:'S',w:1},{label:'D',w:1},{label:'F',w:1},{label:'G',w:1},
    {label:'H',w:1},{label:'J',w:1},{label:'K',w:1},{label:'L',w:1},{label:';',w:1},{label:"'",w:1},{label:'↩',w:2.25} ]},
  { offset:0, keys:[ {label:'⇧',w:2.25},{label:'Z',w:1},{label:'X',w:1},{label:'C',w:1},{label:'V',w:1},
    {label:'B',w:1},{label:'N',w:1},{label:'M',w:1},{label:',',w:1},{label:'.',w:1},{label:'/',w:1},{label:'⇧',w:2.25} ]},
  { offset:0, keys:[ {label:'fn',w:1.2},{label:'⌃',w:1.25},{label:'⌥',w:1.5},{label:'⌘',w:1.75},{label:'Space',w:6.5},
    {label:'⌘',w:1.75},{label:'⌥',w:1.5},{label:'←',w:1},{label:'↑',w:1},{label:'↓',w:1},{label:'→',w:1} ]},
];

const VERTICAL_SCALE = 1.0;
let heightScale = 1.00;
let topShrink   = 0.65;

// math helpers
const vadd=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const vsub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const vmul=(a,s)=>({x:a.x*s,y:a.y*s});
const vlen=a=>Math.hypot(a.x,a.y);
const vnorm=a=>{const L=vlen(a)||1; return {x:a.x/L,y:a.y/L};};
const vrot90=a=>({x:-a.y,y:a.x});
const vdot=(a,b)=>a.x*b.x+a.y*b.y;
const normalDown=dir=>{const n=vrot90(dir); return (vdot(n,{x:0,y:1})>=0)?n:vmul(n,-1);};

function rowTotalUnits(row){ return (row.offset||0)+row.keys.reduce((s,k)=>s+(k.w||1),0); }
function uCenterInRow(row, label){
  const total = rowTotalUnits(row); let cur=(row.offset||0);
  for (const k of row.keys){ const w=k.w||1; if (k.label===label) return (cur + w/2)/total; cur+=w; }
  return 0.5;
}
function findHomeRowIndex(){ return ROWS.findIndex(r => r.keys.some(k=>k.label==='F' || k.label==='J')); }

export function setHeightScale(s){
  heightScale = Math.max(0.3, Math.min(3.0, Number(s)||1.0));
  if (heightVal) heightVal.textContent = `${Math.round(heightScale*100)}%`;
}
export function setTopShrink(s){
  topShrink = Math.max(0.3, Math.min(1.5, Number(s)||0.65));
  if (ratioVal) ratioVal.textContent = topShrink.toFixed(2);
}

export function computeQuadFromFJ(F,J){
  const sep = Math.hypot(J.x-F.x, J.y-F.y);
  if (sep < MIN_SEP_PX) return null;

  const dirTop = vnorm(vsub(J,F));
  const nDown  = normalDown(dirTop);

  const R = ROWS.length;
  const homeIdx = findHomeRowIndex();
  const homeRow = ROWS[homeIdx];

  const uF = uCenterInRow(homeRow,'F');
  const uJ = uCenterInRow(homeRow,'J');
  const deltaU = uJ - uF;

  const scaleBottom = 1 / topShrink;
  const vHome = (homeIdx + 0.5)/R;
  const tHome = 1 - vHome;
  const sHome = 1 + tHome*(scaleBottom - 1);

  const wTop = sep / (sHome * Math.max(1e-6, deltaU));

  const unitsHome = rowTotalUnits(homeRow);
  const oneUnitOnHome = (sHome * wTop) / unitsHome;
  const uy = oneUnitOnHome * VERTICAL_SCALE * heightScale;
  const totalH = R * uy;
  const dHome = totalH * tHome;

  const Ctop = vsub( vsub(F, vmul(nDown, dHome)), vmul(dirTop, (uF - 0.5) * wTop * sHome) );
  const TL = vsub(Ctop, vmul(dirTop, wTop/2));
  const TR = vadd(Ctop, vmul(dirTop, wTop/2));
  const LB = vadd( vadd( vmul(vsub(TL, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );
  const RB = vadd( vadd( vmul(vsub(TR, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );
  return { LB,RB,TR,TL };
}

export function mapRectToQuad(u,v,q){
  const {LB,RB,TR,TL} = q;
  const x = LB.x*(1-u)*(1-v) + RB.x*u*(1-v) + TR.x*u*v + TL.x*(1-u)*v;
  const y = LB.y*(1-u)*(1-v) + RB.y*u*(1-v) + TR.y*u*v + TL.y*(1-u)*v;
  return {x,y};
}

function drawPolygon(points){
  octx.beginPath();
  octx.moveTo(points[0].x, points[0].y);
  for (let i=1;i<points.length;i++){ const p=points[i]; if(!Number.isFinite(p.x)||!Number.isFinite(p.y)) return; octx.lineTo(p.x,p.y); }
  octx.closePath();
  octx.stroke();
}

function drawLabelAtCenter(points, text, fontPx){
  const cx = (points[0].x+points[1].x+points[2].x+points[3].x)/4;
  const cy = (points[0].y+points[1].y+points[2].y+points[3].y)/4;
  octx.font = `${Math.max(10, Math.round(fontPx))}px system-ui`;
  octx.textAlign='center'; octx.textBaseline='middle';
  octx.fillText(text, cx, cy);
}

function isSpecial(label){
  const specials = new Set(['⇥','⇪','⇧','↩','⌫','space','fn','⌃','⌥','⌘','←','↑','↓','→','Space']);
  return specials.has(String(label)) || specials.has(String(label).toLowerCase());
}

export function buildKeyCells(q){
  if (!q) return [];
  const cells = [];
  const R = ROWS.length;
  for (let r=0;r<R;r++){
    const row = ROWS[r];
    const vBot = r/R, vTop = (r+1)/R;
    const totalW = (row.offset||0) + row.keys.reduce((s,k)=>s+(k.w||1),0);
    let cursor = row.offset||0;
    for (const k of row.keys){
      const w = k.w||1;
      const u0 = cursor/totalW, u1 = (cursor+w)/totalW;
      const p0 = mapRectToQuad(u0, vTop, q); // TL
      const p1 = mapRectToQuad(u1, vTop, q); // TR
      const p2 = mapRectToQuad(u1, vBot, q); // BR
      const p3 = mapRectToQuad(u0, vBot, q); // BL
      const cx = (p0.x+p1.x+p2.x+p3.x)/4, cy=(p0.y+p1.y+p2.y+p3.y)/4;
      cells.push({ label:k.label, poly:[p0,p1,p2,p3], center:{x:cx,y:cy} });
      cursor += w;
    }
  }
  return cells;
}

export function findKeyAtPoint(cells, pt){
  function inside(pt, poly){
    let pos=false, neg=false;
    for (let i=0;i<poly.length;i++){
      const a=poly[i], b=poly[(i+1)%poly.length];
      const cross = (b.x-a.x)*(pt.y-a.y) - (b.y-a.y)*(pt.x-a.x);
      if (cross<0) neg=true; if (cross>0) pos=true; if (pos&&neg) return false;
    }
    return true;
  }
  for (const c of cells){ if (inside(pt, c.poly)) return c; }
  return null;
}

export function drawKeyboard(q){
  if (!q) return;
  const R = ROWS.length;
  const homeIdx = findHomeRowIndex();
  const vTop = (homeIdx + 2/3)/R;
  const vBot = (homeIdx + 1/3)/R;
  const pTop = mapRectToQuad(0.5, vTop, q);
  const pBot = mapRectToQuad(0.5, vBot, q);
  const keyH = Math.hypot(pTop.x-pBot.x, pTop.y-pBot.y);
  const labelSize = keyH * 0.45;

  for (let r=0;r<R;r++){
    const row = ROWS[r];
    const vB = r/R, vT=(r+1)/R;
    const totalW = (row.offset||0) + row.keys.reduce((s,k)=>s+(k.w||1),0);
    let cursor = row.offset||0;
    for (const k of row.keys){
      const w=k.w||1;
      const u0=cursor/totalW, u1=(cursor+w)/totalW;
      const p0 = mapRectToQuad(u0, vT, q), p1 = mapRectToQuad(u1, vT, q);
      const p2 = mapRectToQuad(u1, vB, q), p3 = mapRectToQuad(u0, vB, q);
      const special = isSpecial(k.label);
      octx.lineWidth = special ? 2 : 1.25;
      octx.strokeStyle = special ? 'rgba(0,120,0,0.95)' : 'rgba(0,128,255,0.6)';
      octx.fillStyle   = special ? 'rgba(0,120,0,0.08)' : 'rgba(0,128,255,0.08)';
      drawPolygon([p0,p1,p2,p3]); octx.fill();
      octx.fillStyle='#0a0a0a'; drawLabelAtCenter([p0,p1,p2,p3], k.label, labelSize);
      if (k.label==='F' || k.label==='J'){ octx.strokeStyle='rgba(0,200,0,0.95)'; octx.lineWidth=2.25; drawPolygon([p0,p1,p2,p3]); }
      cursor += w;
    }
  }
}

export function clearOverlay(){ octx.clearRect(0,0,overlay.width,overlay.height); }
export function resizeOverlayToVideo(W,H){ overlay.width=W; overlay.height=H; }

export function drawDebugFJ(F,J){
  if (!showDebugChk.checked || !F || !J) return;
  octx.strokeStyle='rgba(0,255,255,0.95)'; octx.lineWidth=2;
  const drawX=(pt,r=6)=>{ octx.beginPath(); octx.moveTo(pt.x-r,pt.y-r); octx.lineTo(pt.x+r,pt.y+r);
                          octx.moveTo(pt.x+r,pt.y-r); octx.lineTo(pt.x-r,pt.y+r); octx.stroke(); };
  drawX(F); drawX(J);
}

export const calibState = {
  fjCalib: null, quad: null, frozen:false, startMs:null
};

export function startCalibration(){
  calibState.fjCalib=null; calibState.quad=null; calibState.frozen=false; calibState.startMs=null;
  statusEl.textContent='Calibrating…';
}

export function updateSlidersFromUI(){
  setHeightScale(heightSlider.value); setTopShrink(ratioSlider.value);
}

// pick left/right index fingertips from refined tips
export function pickFJFromTips(tips, W){
  if (!tips?.length) return null;
  // only index fingertips
  const idxTips = tips.filter(t => t.finger === 'Index');
  if (idxTips.length < 2) return null;
  // sort by x to guess left/right
  const sorted = idxTips.slice().sort((a,b)=>a.x-b.x);
  return { F: sorted[0], J: sorted[sorted.length-1] };
}

export function updateCalibrationFromTips(tips, nowMs){
  const fj = pickFJFromTips(tips, overlay.width);
  if (!fj){ statusEl.textContent='Need both index fingers on F/J…'; return; }
  if (!calibState.frozen){
    calibState.fjCalib = fj;
    const q = computeQuadFromFJ(fj.F, fj.J);
    if (q){
      calibState.quad = q;
      if (calibState.startMs === null) calibState.startMs = nowMs;
      const elapsed = (nowMs - calibState.startMs)/1000;
      if (elapsed >= 10){ calibState.frozen = true; statusEl.textContent='Frozen'; }
      else { statusEl.textContent = `Calibrating… ${(10 - elapsed).toFixed(1)}s`; }
    } else {
      statusEl.textContent='Calibrating…';
    }
  } else {
    statusEl.textContent='Frozen';
  }
}

// small label near fingertip showing detected key
export function drawFingerKeyLabels(tips, q){
  if (!q) return;
  const cells = buildKeyCells(q); if (!cells.length) return;
  for (const t of tips){
    const hit = findKeyAtPoint(cells, {x:t.x, y:t.y});
    const label = hit ? `${t.tag || t.finger}: ${hit.label}` : `${t.tag || t.finger}: —`;
    drawPill(label, t.x, t.y - 12);
  }
}
function drawPill(text,x,y){
  octx.save();
  octx.font='12px system-ui';
  const padX=6, padY=3;
  const m = octx.measureText(text);
  const w = Math.ceil(m.width) + padX*2, h=16+(padY-3), r=8;
  const left=Math.round(x - w/2), top=Math.round(y - h);
  octx.beginPath();
  octx.moveTo(left+r, top);
  octx.arcTo(left+w, top, left+w, top+h, r);
  octx.arcTo(left+w, top+h, left, top+h, r);
  octx.arcTo(left, top+h, left, top, r);
  octx.arcTo(left, top, left+w, top, r);
  octx.closePath();
  octx.fillStyle='rgba(255,255,255,0.85)'; octx.fill();
  octx.strokeStyle='rgba(0,0,0,0.25)'; octx.stroke();
  octx.fillStyle='#111'; octx.textAlign='center'; octx.textBaseline='middle';
  octx.fillText(text, left+w/2, top+h/2);
  octx.restore();
}
