// HoloKeys — F/J Calibration + QWERTY Keyboard Overlay (10s freeze + Recalibrate)
// Adds number row, punctuation, Shift, Enter, and Space (variable-width keys).

import {
  HandLandmarker,
  FilesetResolver,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

// ---------- DOM ----------
const video   = document.getElementById('preview');
const overlay = document.getElementById('overlay');
const octx    = overlay.getContext('2d');

const startBtn = document.getElementById('start');
const stopBtn  = document.getElementById('stop');
const camSel   = document.getElementById('cameraSelect');
const snapBtn  = document.getElementById('snap');
const liveChk  = document.getElementById('live');
const showHandsChk = document.getElementById('showHands');
const showDebugChk = document.getElementById('showDebug');
const blackChk = document.getElementById('blackMode');
const whiteChk = document.getElementById('whiteMode'); 
const recalBtn = document.getElementById('recalibrate');
const statusEl = document.getElementById('status');

const heightSlider = document.getElementById('height');
const heightVal    = document.getElementById('heightVal');
const ratioSlider  = document.getElementById('ratio');
const ratioVal     = document.getElementById('ratioVal');

const heightDefaultBtn = document.getElementById('heightDefault');
const ratioDefaultBtn  = document.getElementById('ratioDefault');

const frameCanvas = document.getElementById('frame');
const frameCtx    = frameCanvas.getContext('2d', { willReadFrequently: true });

// ---------- Config ----------
const MIRROR_PREVIEW = true;     // mirror video ONLY
const CALIBRATION_SECONDS = 10;  // freeze overlay after 10s of valid calibration

// Base "logical" grid used only for the F/J solve (home row = 10 logical columns)
const NUM_COLS = 10;         // keys per row for the solve (A..; mapped to 10)
const F_COL = 3;             // index of 'F' in home row (0-based across 10)
const J_COL = 6;             // index of 'J' in home row

// Visual keyboard definition (bottom → top). Variable-width keys supported.
// Bottom → Top (mirrored view): Number row at the very bottom, Space/modifiers at the top.
const ROWS = [
  // ── 0: Number row (bottommost)
  { offset: 0,
    keys: [
      {label:'`',w:1},{label:'1',w:1},{label:'2',w:1},{label:'3',w:1},{label:'4',w:1},{label:'5',w:1},
      {label:'6',w:1},{label:'7',w:1},{label:'8',w:1},{label:'9',w:1},{label:'0',w:1},{label:'-',w:1},{label:'=',w:1},
      {label:'⌫',w:1.5}, // Delete (backspace)
    ]
  },

  // ── 1: QWERTY row (with Tab at left, brackets + backslash on right)
  { offset: 0,
    keys: [
      {label:'⇥',w:1.5}, // Tab
      {label:'Q',w:1},{label:'W',w:1},{label:'E',w:1},{label:'R',w:1},{label:'T',w:1},
      {label:'Y',w:1},{label:'U',w:1},{label:'I',w:1},{label:'O',w:1},{label:'P',w:1},
      {label:'[',w:1},{label:']',w:1},{label:'\\',w:1},
    ]
  },

  // ── 2: Home row (Caps at left, wide Return at right)
  { offset: 0,
    keys: [
      {label:'⇪',w:1.75}, // Caps Lock
      {label:'A',w:1},{label:'S',w:1},{label:'D',w:1},{label:'F',w:1},{label:'G',w:1},
      {label:'H',w:1},{label:'J',w:1},{label:'K',w:1},{label:'L',w:1},{label:';',w:1},{label:"'",w:1},
      {label:'↩',w:2.25}, // Return
    ]
  },

  // ── 3: ZXCV row (wide Shifts)
  { offset: 0,
    keys: [
      {label:'⇧',w:2.25}, // Left Shift
      {label:'Z',w:1},{label:'X',w:1},{label:'C',w:1},{label:'V',w:1},
      {label:'B',w:1},{label:'N',w:1},{label:'M',w:1},{label:',',w:1},{label:'.',w:1},{label:'/',w:1},
      {label:'⇧',w:2.25}, // Right Shift
    ]
  },

  // ── 4: Modifiers + Space + Arrows (topmost)
  { offset: 0,
    keys: [
      {label:'fn',w:1.2},{label:'⌃',w:1.25},{label:'⌥',w:1.5},{label:'⌘',w:1.75},
      {label:'Space',w:6.5},
      {label:'⌘',w:1.75},{label:'⌥',w:1.5},
      {label:'←',w:1},{label:'↑',w:1},{label:'↓',w:1},{label:'→',w:1},
    ]
  },
];

// Tuning (defaults)
const VERTICAL_SCALE = 1.0;  // vertical pitch relative to horizontal pitch
const MIN_SEP_PX = 80;       // minimum F–J separation to accept calibration

// ---------- State ----------
let stream = null;
let currentDeviceId = null;
let lastVideoTime = -1;

let fjCalib = null;    // {F:{x,y}, J:{x,y}} current calibration sample
let quad = null;       // {LB,RB,TR,TL} current overlay quad
let frozen = false;    // when true, quad is locked
let calibStartMs = null;

let handLandmarker = null;
let drawer = null;

// User-adjustable scales (with defaults)
let heightScale = 1.00;   // 1.00 = default height
let topShrink   = 0.65;   // width_top / width_bottom (0.65 default trapezoid)

// ---------- UI setters ----------
function setHeightScale(s) {
  const v = Math.max(0.3, Math.min(3.0, Number(s) || 1.0)); // clamp
  heightScale = v;
  if (heightVal) heightVal.textContent = `${Math.round(v * 100)}%`;
  if (fjCalib) quad = computeQuadFromFJ(fjCalib.F, fjCalib.J);
}

function setTopShrink(s) {
  const v = Math.max(0.3, Math.min(1.5, Number(s) || 0.65)); // clamp
  topShrink = v;
  if (ratioVal) ratioVal.textContent = v.toFixed(2);
  if (fjCalib) quad = computeQuadFromFJ(fjCalib.F, fjCalib.J);
}

// ---------- Camera ----------
async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  camSel.innerHTML = '';
  cams.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i+1}`;
    camSel.appendChild(opt);
  });
  if (currentDeviceId) camSel.value = currentDeviceId;
}

function stopStream() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  stopBtn.disabled = true;
}

function resizeOverlayToVideo() {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return;
  overlay.width = w;
  overlay.height = h;
}

async function startStream(constraints) {
  try {
    stopStream();
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    stopBtn.disabled = false;
    await listCameras();

    // Mirror the video only; overlay remains normal (so text isn't mirrored)
    video.style.transform = MIRROR_PREVIEW ? 'scaleX(-1)' : 'none';
    overlay.style.transform = 'none';

    resizeOverlayToVideo();
    updateBlackMode();
    startCalibration(); // fresh 10s window
  } catch (err) {
    alert('Camera error: ' + (err?.message || err));
    console.error(err);
  }
}

async function captureJpegFromVideo(video, {quality = 0.92} = {}) {
  const w = video.videoWidth, h = video.videoHeight;
  frameCanvas.width = w; frameCanvas.height = h;
  // Save snapshot mirrored like preview
  frameCtx.setTransform(MIRROR_PREVIEW ? -1 : 1, 0, 0, 1, MIRROR_PREVIEW ? w : 0, 0);
  frameCtx.drawImage(video, 0, 0, w, h);
  const blob = await new Promise(res => frameCanvas.toBlob(res, 'image/jpeg', quality));
  return blob;
}

async function downloadSnapshot() {
  const blob = await captureJpegFromVideo(video, {quality: 0.92});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url; a.download = `frame-${ts}.jpg`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// ---------- Math helpers ----------
const lerp = (a,b,t)=>a+(b-a)*t;
const vadd=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const vsub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const vmul=(a,s)=>({x:a.x*s,y:a.y*s});
const vlen=a=>Math.hypot(a.x,a.y);
const vnorm=a=>{const L=vlen(a)||1; return {x:a.x/L,y:a.y/L};};
const vrot90=a=>({x:-a.y,y:a.x});
const vdot=(a,b)=>a.x*b.x+a.y*b.y;
const normalDown=dir=>{const n=vrot90(dir); return (vdot(n,{x:0,y:1})>=0)?n:vmul(n,-1);};

// ----- Fingertip → key hit-testing -----
const FINGER_TIPS  = [4, 8, 12, 16, 20];                     // thumb,index,middle,ring,pinky
const FINGER_NAMES = ['Thumb','Index','Middle','Ring','Pinky'];


function buildKeyCells(q) {
  if (!q) return [];
  const cells = [];
  const R = ROWS.length;

  for (let r = 0; r < R; r++) {
    const row = ROWS[r];
    const vBot = r / R;
    const vTop = (r + 1) / R;

    // <-- use the new aligned layout
    const segments = computeRowKeyIntervals(row, r, HOME_LETTER_INFO);

    for (const seg of segments) {
      const k = seg.key;
      const u0 = seg.u0;
      const u1 = seg.u1;

      const p0 = mapRectToQuad(u0, vTop, q); // TL
      const p1 = mapRectToQuad(u1, vTop, q); // TR
      const p2 = mapRectToQuad(u1, vBot, q); // BR
      const p3 = mapRectToQuad(u0, vBot, q); // BL

      const cx = (p0.x + p1.x + p2.x + p3.x) / 4;
      const cy = (p0.y + p1.y + p2.y + p3.y) / 4;

      cells.push({
        label: k.label,
        poly: [p0, p1, p2, p3],
        center: { x: cx, y: cy }
      });
    }
  }

  return cells;
}


function pointInConvexPolygon(pt, poly) {
  // Works for TL→TR→BR→BL order we generate
  let pos = false, neg = false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i+1) % poly.length];
    const cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    if (cross < 0) neg = true;
    if (cross > 0) pos = true;
    if (pos && neg) return false;
  }
  return true;
}

function findKeyAtPoint(cells, pt) {
  for (const c of cells) {
    if (pointInConvexPolygon(pt, c.poly)) return c;
  }
  return null;
}

// Fingertip screen coords (NOT mirrored overlay)
function getAllFingertipsScreen(result) {
  const tips = [];
  if (!result || !result.landmarks || result.landmarks.length === 0) return tips;
  const { landmarks, handednesses } = result;
  const W = overlay.width, H = overlay.height;

  // Map hand index -> 'L' / 'R'
  const handLR = new Array(landmarks.length).fill('?');
  if (Array.isArray(handednesses) && handednesses.length === landmarks.length) {
    for (let i = 0; i < handednesses.length; i++) {
      const label = handednesses[i]?.[0]?.categoryName?.toLowerCase?.() || '';
      handLR[i] = label.includes('left') ? 'L' : label.includes('right') ? 'R' : '?';
    }
  } else if (landmarks.length === 2) {
    // Fallback by x-position of index fingertips
    const xs = landmarks.map(h => {
      const x = h[8].x * W;
      return MIRROR_PREVIEW ? (W - x) : x;
    });
    if (xs[0] <= xs[1]) { handLR[0] = 'L'; handLR[1] = 'R'; }
    else { handLR[0] = 'R'; handLR[1] = 'L'; }
  }

  for (let hi = 0; hi < landmarks.length; hi++) {
    for (let fi = 0; fi < FINGER_TIPS.length; fi++) {
      const li = FINGER_TIPS[fi];
      const lm = landmarks[hi][li];
      let x = lm.x * W, y = lm.y * H;
      if (MIRROR_PREVIEW) x = W - x; // convert to overlay (non-mirrored) space
      tips.push({
        x, y,
        hand: handLR[hi],
        finger: FINGER_NAMES[fi],
        tag: `${handLR[hi]}-${FINGER_NAMES[fi]}`
      });
    }
  }
  return tips;
}

// Tiny rounded pill label
function drawPillLabel(text, x, y) {
  octx.save();
  octx.font = '12px system-ui';
  const padX = 6, padY = 3;
  const m = octx.measureText(text);
  const w = Math.ceil(m.width) + padX * 2;
  const h = 16 + (padY-3); // approximate height
  const r = 8;
  const left = Math.round(x - w/2), top = Math.round(y - h);

  octx.beginPath();
  octx.moveTo(left + r, top);
  octx.arcTo(left + w, top, left + w, top + h, r);
  octx.arcTo(left + w, top + h, left, top + h, r);
  octx.arcTo(left, top + h, left, top, r);
  octx.arcTo(left, top, left + w, top, r);
  octx.closePath();
  octx.fillStyle = 'rgba(255,255,255,0.85)';
  octx.fill();
  octx.strokeStyle = 'rgba(0,0,0,0.25)';
  octx.stroke();

  octx.fillStyle = '#111';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(text, left + w/2, top + h/2);
  octx.restore();
}

// Draw labels like "L-Index: F" near fingertips
function drawFingerKeyLabels(result, q) {
  if (!q || !result) return;
  const cells = buildKeyCells(q);
  if (!cells.length) return;
  const tips = getAllFingertipsScreen(result);
  for (const t of tips) {
    const hit = findKeyAtPoint(cells, {x:t.x, y:t.y});
    const label = hit ? `${t.tag}: ${hit.label}` : `${t.tag}: —`;
    // slight offset so it doesn't sit directly on the fingertip dot
    drawPillLabel(label, t.x, t.y - 12);
  }
}


function rowTotalUnits(row) {
  return (row.offset || 0) + row.keys.reduce((s,k)=>s+(k.w||1), 0);
}
function uCenterInRow(row, keyLabel) {
  const total = rowTotalUnits(row);
  let cur = (row.offset || 0);
  for (const k of row.keys) {
    const w = k.w || 1;
    if (k.label === keyLabel) return (cur + w/2) / total;
    cur += w;
  }
  return 0.5; // fallback
}
function findHomeRowIndex() {
  for (let i=0;i<ROWS.length;i++) {
    const lbls = ROWS[i].keys.map(k=>k.label);
    if (lbls.includes('F') && lbls.includes('J')) return i;
  }
  return Math.floor(ROWS.length/2);
}

function getAlignedKeyCenterU(rowIndex, label) {
  const row = ROWS[rowIndex];

  // if aligned layout is available, use it
  if (typeof computeRowKeyIntervals === 'function' &&
      typeof HOME_LETTER_INFO !== 'undefined') {
    const segs = computeRowKeyIntervals(row, rowIndex, HOME_LETTER_INFO);
    const seg = segs.find(s => s.key.label === label);
    if (seg) {
      return (seg.u0 + seg.u1) / 2;
    }
  }

  // fallback to original per-row math
  return uCenterInRow(row, label);
}

// --- keep Q/A/Z columns aligned across rows ---
// rows 1,2,3 in ROWS = QWERTY, home, ZXCV in your current file
//const LETTER_ROW_INDICES = new Set([1, 2, 3]);
const LETTER_ROW_INDICES = new Set([0, 1, 2, 3]);

// how much to shift each letter row, in *columns* (not in px)
// 1 = whole key width, 0.5 = half key width
// mac-style: A and Z rows are to the RIGHT of Q row by about half a key
const LETTER_ROW_STAGGER_COLS = {
  0: -0.5,   // number row sits right over Q
  1: 0.0,   // row 1 → QWERTY → base, no shift
  2: 0.28,   // row 2 → ASDF   → half-key to the right
  3: 0.75,   // row 3 → ZXCV   → same as ASDF
};

// treat these as “letterish” so they share the same columns
// function isLetterishLabel(label) {
//   return /^[A-Z]$/.test(label) || [';', ',', '.', '/'].includes(label);
// }
function isLetterishLabel(label) {
  // letters OR digits OR the small punctuation we put in the letter block
  return /^[A-Z]$/.test(label) ||
         /^[0-9]$/.test(label) ||
         [';', ',', '.', '/'].includes(label);
}


// look at the home row (the one with F/J) and find the exact span
// that covers its letters — we will reuse this span for the other rows
function computeHomeLetterInfo() {
  const homeIndex = findHomeRowIndex();
  const row = ROWS[homeIndex];
  const total = rowTotalUnits(row);

  let cursor = row.offset || 0;
  let firstU = null;
  let lastU = null;
  let count = 0;

  for (const k of row.keys) {
    const w = k.w || 1;
    if (isLetterishLabel(k.label)) {
      if (firstU === null) firstU = cursor / total;
      lastU = (cursor + w) / total;
      count++;
    }
    cursor += w;
  }

  // fallback guard
  return {
    homeIndex,
    u0: firstU ?? 0.2,
    u1: lastU ?? 0.8,
    letterCount: count,
  };
}

const HOME_LETTER_INFO = computeHomeLetterInfo();


function computeRowKeyIntervals(row, rowIndex, letterInfo) {
  const total = rowTotalUnits(row);

  // rows that we DON'T normalize/stagger → old behavior
  if (!letterInfo || !LETTER_ROW_INDICES.has(rowIndex)) {
    let cursor = row.offset || 0;
    return row.keys.map((k) => {
      const w = k.w || 1;
      const u0 = cursor / total;
      const u1 = (cursor + w) / total;
      cursor += w;
      return { key: k, u0, u1 };
    });
  }

  // --- we ARE in a letter row → lock to home-row span ---
  const { u0: baseL0, u1: baseL1 } = letterInfo;

  // split this row into 3 chunks: left stuff, letters, right stuff
  const left = [];
  const letters = [];
  const right = [];
  let seenLetter = false;
  for (const k of row.keys) {
    const w = k.w || 1;
    const isL = isLetterishLabel(k.label);
    if (isL) {
      seenLetter = true;
      letters.push({ key: k, w });
    } else if (!seenLetter) {
      left.push({ key: k, w });
    } else {
      right.push({ key: k, w });
    }
  }

  const N = letters.length || 1;
  const colW = (baseL1 - baseL0) / N;

  // how many columns to shift this *whole row* by (mac-style stagger)
  const staggerCols = LETTER_ROW_STAGGER_COLS[rowIndex] || 0;
  let letterStart = baseL0 + staggerCols * colW;
  let letterEnd   = letterStart + N * colW;

  // clamp so we don't spill past 0..1
  if (letterStart < 0) {
    letterEnd -= letterStart;
    letterStart = 0;
  }
  if (letterEnd > 1) {
    const over = letterEnd - 1;
    letterStart -= over;
    letterEnd = 1;
  }

  const intervals = [];

  // 1) LEFT group → [0, letterStart)
  const leftTotal = left.reduce((s, x) => s + x.w, 0) || 1;
  let acc = 0;
  for (const item of left) {
    const u0 = letterStart * (acc / leftTotal);
    const u1 = letterStart * ((acc + item.w) / leftTotal);
    intervals.push({ key: item.key, u0, u1 });
    acc += item.w;
  }

  // 2) LETTER group → evenly spaced in [letterStart, letterEnd)
  for (let i = 0; i < N; i++) {
    const item = letters[i];
    const u0 = letterStart + (letterEnd - letterStart) * (i / N);
    const u1 = letterStart + (letterEnd - letterStart) * ((i + 1) / N);
    intervals.push({ key: item.key, u0, u1 });
  }

  // 3) RIGHT group → [letterEnd, 1]
  const rightTotal = right.reduce((s, x) => s + x.w, 0) || 1;
  acc = 0;
  for (const item of right) {
    const u0 = letterEnd + (1 - letterEnd) * (acc / rightTotal);
    const u1 = letterEnd + (1 - letterEnd) * ((acc + item.w) / rightTotal);
    intervals.push({ key: item.key, u0, u1 });
    acc += item.w;
  }

  // keep left → letters → right order
  intervals.sort((a, b) => a.u0 - b.u0);
  return intervals;
}



// ---------- Geometry solve so F/J land on HOME row centers ----------
/**
 * Given F and J fingertip points in *screen coords* (already mirrored if preview is),
 * solve the keyboard quad so that the centers of the home-row F and J keys map
 * exactly to those points.
 */
function computeQuadFromFJ(F, J){
  const sep = Math.hypot(J.x - F.x, J.y - F.y);
  if (sep < MIN_SEP_PX) return null;

  const dirTop = vnorm(vsub(J,F));      // left→right along top edge
  const nDown  = normalDown(dirTop);    // toward viewer

  // --- Use real home-row geometry (variable widths + offset) ---
  const R = ROWS.length;
  const homeIdx = findHomeRowIndex();
  const homeRow = ROWS[homeIdx];

  // Horizontal fractions for F and J within the *home row* as drawn
  // const uF = uCenterInRow(homeRow, 'F');
  // const uJ = uCenterInRow(homeRow, 'J');
  const uF = getAlignedKeyCenterU(homeIdx, 'F');
  const uJ = getAlignedKeyCenterU(homeIdx, 'J');
  const deltaU = uJ - uF;                      // F→J span in row-fraction

  // Perspective: top vs bottom width (user-adjustable)
  const scaleBottom = 1 / topShrink;           // >1 means bottom wider than top
  const vHome = (homeIdx + 0.5) / R;           // exact vertical center of home row
  const tHome = 1 - vHome;                     // fraction down from top edge
  const sHome = 1 + tHome * (scaleBottom - 1); // horizontal scale at home row vs top

  // Top width so that F↔J at home row matches measured separation
  const wTop = sep / (sHome * Math.max(1e-6, deltaU));

  // Vertical pitch: use "one unit" width on the home row as reference
  const unitsHome = rowTotalUnits(homeRow);    // sum(offset + widths) on home row
  const oneUnitOnHome = (sHome * wTop) / unitsHome;
  const uy = oneUnitOnHome * VERTICAL_SCALE * heightScale; // per-row vertical step
  const totalH = R * uy;
  const dHome = totalH * tHome;

  // Place the top edge center so the home-row F/J land exactly on the fingertips
  const Ctop = vsub( vsub(F, vmul(nDown, dHome)), vmul(dirTop, (uF - 0.5) * wTop * sHome) );

  // Construct quad
  const TL = vsub(Ctop, vmul(dirTop, wTop/2));
  const TR = vadd(Ctop, vmul(dirTop, wTop/2));
  const LB = vadd( vadd( vmul(vsub(TL, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );
  const RB = vadd( vadd( vmul(vsub(TR, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );

  return { LB, RB, TR, TL };
}

// Bilinear map with v=0 bottom row, v=1 top row
function mapRectToQuad(u, v, q){
  const {LB, RB, TR, TL} = q;
  const x = LB.x*(1-u)*(1-v) + RB.x*u*(1-v) + TR.x*u*v + TL.x*(1-u)*v;
  const y = LB.y*(1-u)*(1-v) + RB.y*u*(1-v) + TR.y*u*v + TL.y*(1-u)*v;
  return {x, y};
}

function drawPolygon(points) {
  octx.beginPath();
  octx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    // Guard against bad coords just in case
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    octx.lineTo(p.x, p.y);   // ← was missing the y argument
  }
  octx.closePath();
  octx.stroke();
}

function drawLabelAtCenter(points, text, fontPx) {
  const cx = (points[0].x + points[1].x + points[2].x + points[3].x) / 4;
  const cy = (points[0].y + points[1].y + points[2].y + points[3].y) / 4;
  octx.font = `${Math.max(10, Math.round(fontPx))}px system-ui`;
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(text, cx, cy);
}

function isSpecial(labelRaw){
  const label = String(labelRaw).toLowerCase();
  const specials = new Set([
    '⇥','⇪','⇧','↩','⌫','space','fn','⌃','⌥','⌘','←','↑','↓','→'
  ]);
  return specials.has(label) || specials.has(labelRaw);
}


function drawKeyboard(q) {
  if (!q) return;

  const R = ROWS.length;

  // estimate label size from home row as before
  const homeRowIdx = ROWS.findIndex(row => row.keys.some(k => k.label === 'F'));
  const vBandTop = (homeRowIdx + 2/3) / R;
  const vBandBot = (homeRowIdx + 1/3) / R;
  const pTop = mapRectToQuad(0.5, vBandTop, q);
  const pBot = mapRectToQuad(0.5, vBandBot, q);
  const keyHeightPx = Math.hypot(pTop.x - pBot.x, pTop.y - pBot.y);
  const labelSize = keyHeightPx * 0.64;

  for (let r = 0; r < R; r++) {
    const row = ROWS[r];
    const vBot = r / R;
    const vTop = (r + 1) / R;

    // <-- use aligned layout
    const segments = computeRowKeyIntervals(row, r, HOME_LETTER_INFO);

    for (const seg of segments) {
      const k = seg.key;
      const u0 = seg.u0;
      const u1 = seg.u1;

      const p0 = mapRectToQuad(u0, vTop, q); // TL
      const p1 = mapRectToQuad(u1, vTop, q); // TR
      const p2 = mapRectToQuad(u1, vBot, q); // BR
      const p3 = mapRectToQuad(u0, vBot, q); // BL

      const special = isSpecial(k.label);
      octx.lineWidth = special ? 2 : 1.25;
      octx.strokeStyle = special ? 'rgba(0,120,0,0.95)' : 'rgba(0,128,255,0.6)';
      octx.fillStyle   = special ? 'rgba(0,120,0,0.14)' : 'rgba(0,128,255,0.14)';

      drawPolygon([p0, p1, p2, p3]);
      octx.fill();

      octx.fillStyle = '#0a0a0a';
      drawLabelAtCenter([p0, p1, p2, p3], k.label, labelSize);

      if (k.label === 'F' || k.label === 'J') {
        octx.strokeStyle = 'rgba(0,200,0,0.95)';
        octx.lineWidth = 2.25;
        drawPolygon([p0, p1, p2, p3]);
      }
    }
  }

  // existing debug crosses
  if (showDebugChk.checked && fjCalib) {
    octx.strokeStyle = 'rgba(0,255,255,0.95)';
    octx.lineWidth = 2;
    const drawX = (pt, r=6) => {
      octx.beginPath();
      octx.moveTo(pt.x - r, pt.y - r);
      octx.lineTo(pt.x + r, pt.y + r);
      octx.moveTo(pt.x + r, pt.y - r);
      octx.lineTo(pt.x - r, pt.y + r);
      octx.stroke();
    };
    drawX(fjCalib.F);
    drawX(fjCalib.J);
  }
}


// ---------- MediaPipe Hands ----------
const vision = await FilesetResolver.forVisionTasks(
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
);
handLandmarker = await HandLandmarker.createFromOptions(vision, {
  baseOptions: { modelAssetPath:
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
    delegate: "GPU"
  },
  runningMode: "VIDEO",
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5
});
drawer = new DrawingUtils(octx);

function drawHands(result){
  if (!result || !showHandsChk.checked) return;
  const { landmarks } = result;
  if (!landmarks) return;

  // Mirror ONLY the landmark drawing so it matches the mirrored video.
  octx.save();
  if (MIRROR_PREVIEW) {
    octx.translate(overlay.width, 0);
    octx.scale(-1, 1);
  }

  for (const hand of landmarks) {
    drawer.drawConnectors(hand, HandLandmarker.HAND_CONNECTIONS, { lineWidth: 2 });
    drawer.drawLandmarks(hand, { radius: 2.5 });
  }

  octx.restore();
}

// Fingertips in *screen coords* (we flip X if the preview is mirrored)
function pickFJFromResult(result){
  if (!result) return null;
  const { landmarks, handednesses } = result;
  if (!landmarks || landmarks.length === 0) return null;

  const W = overlay.width, H = overlay.height;
  const tips = landmarks.map(hand => {
    const t = hand[8]; // index fingertip
    const x = t.x * W;
    const y = t.y * H;
    return { x: MIRROR_PREVIEW ? (W - x) : x, y }; // convert to screen coords
  });

  let leftIdx = -1, rightIdx = -1;
  if (Array.isArray(handednesses) && handednesses.length === landmarks.length) {
    for (let i=0;i<handednesses.length;i++) {
      const label = handednesses[i]?.[0]?.categoryName?.toLowerCase?.() ?? '';
      if (label.includes('left'))  leftIdx = i;
      if (label.includes('right')) rightIdx = i;
    }
  }
  if (leftIdx === -1 || rightIdx === -1) {
    const order = [...tips.keys()].sort((a,b)=>tips[a].x - tips[b].x);
    leftIdx = order[0]; rightIdx = order[order.length-1];
  }
  return { F: tips[leftIdx], J: tips[rightIdx] };
}

// Update calibration only when not frozen; start 10s timer on first valid quad.
function updateCalibration(result, nowMs){
  const fj = pickFJFromResult(result);
  if (!fj) { statusEl.textContent = 'Need both hands on F/J…'; return; }

  if (!frozen) {
    fjCalib = fj;
    const q = computeQuadFromFJ(fjCalib.F, fjCalib.J);
    if (q) {
      quad = q;
      if (calibStartMs === null) calibStartMs = nowMs; // start countdown
      const elapsed = (nowMs - calibStartMs) / 1000;
      const left = Math.max(0, CALIBRATION_SECONDS - elapsed);
      if (elapsed >= CALIBRATION_SECONDS) {
        frozen = true;
        statusEl.textContent = 'Frozen';
      } else {
        statusEl.textContent = `Calibrating… ${left.toFixed(1)}s`;
      }
    } else {
      statusEl.textContent = 'Calibrating…';
    }
  } else {
    statusEl.textContent = 'Frozen';
  }
}

// ---------- Black screen toggle ----------
// function updateBlackMode() {
//   overlay.style.background = blackChk.checked ? '#000' : 'transparent';
// }
// ---------- Screen color toggle ----------
function updateBlackMode() {
  if (blackChk && blackChk.checked) {
    overlay.style.background = '#000';
  } else if (whiteChk && whiteChk.checked) {
    overlay.style.background = '#fff';
  } else {
    overlay.style.background = 'transparent';
  }
}


// ---------- Calibration control ----------
function startCalibration() {
  frozen = false;
  calibStartMs = null;
  fjCalib = null;
  quad = null;
  statusEl.textContent = 'Calibrating…';
}

// ---------- Main loop ----------
function clearOverlay(){ octx.clearRect(0,0,overlay.width,overlay.height); }

function pump(){
  if (!stream) { requestAnimationFrame(pump); return; }

  const w = video.videoWidth, h = video.videoHeight;
  if (w && h) {
    if (overlay.width !== w || overlay.height !== h) resizeOverlayToVideo();

    if (liveChk.checked) {
      const nowMs = performance.now();
      const vt = video.currentTime;
      if (vt !== lastVideoTime) {
        try {
          const result = handLandmarker.detectForVideo(video, nowMs);
          clearOverlay();
          drawHands(result);
          if (!frozen) updateCalibration(result, nowMs);
          drawKeyboard(quad);
          drawFingerKeyLabels(result, quad);
          lastVideoTime = vt;
        } catch (e) {
          console.error('detect/draw error', e);
          statusEl.textContent = '⚠️ detection error (see console)';
        }
      }
    } else {
      clearOverlay();
    }
  } else {
    clearOverlay();
  }
  requestAnimationFrame(pump);
}

// ---------- Wire up UI ----------
async function startStreamWith(constraints){
  await startStream(constraints);
}

// startBtn.addEventListener('click', async () => {
//   await startStreamWith({
//     video: { facingMode: { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } },
//     audio: false
//   });
// });
startBtn.textContent = 'Start (front cam)';
startBtn.addEventListener('click', async () => {
  currentDeviceId = null; // reset any prior manual selection
  await startStreamWith({
    video: { facingMode: 'user' },   // minimal; string form works best on iOS/Android
    audio: false
  });

  // sanity check & display what we actually got
  const track = stream?.getVideoTracks?.()[0];
  if (track) {
    const s = track.getSettings?.() || {};
    statusEl.textContent = `Using: ${s.facingMode || 'unknown'} — ${track.label || 'camera'}`;
  }
});
camSel.addEventListener('change', async () => {
  currentDeviceId = camSel.value;
  await startStreamWith({ video: { deviceId: { exact: currentDeviceId } }, audio: false });
});
stopBtn.addEventListener('click', () => { stopStream(); clearOverlay(); });
snapBtn.addEventListener('click', downloadSnapshot);
// blackChk.addEventListener('change', updateBlackMode);
blackChk.addEventListener('change', () => {
  if (blackChk.checked && whiteChk) {
    whiteChk.checked = false;         // make them exclusive
  }
  updateBlackMode();
});

if (whiteChk) {
  whiteChk.addEventListener('change', () => {
    if (whiteChk.checked && blackChk) {
      blackChk.checked = false;       // make them exclusive
    }
    updateBlackMode();
  });
}

recalBtn.addEventListener('click', () => { startCalibration(); });

// Height slider
if (heightSlider) {
  setHeightScale(heightSlider.value);                // initialize UI → state
  heightSlider.addEventListener('input', (e) => setHeightScale(e.target.value));
}
// Ratio slider
if (ratioSlider) {
  setTopShrink(ratioSlider.value);                   // initialize UI → state
  ratioSlider.addEventListener('input', (e) => setTopShrink(e.target.value));
}
// Defaults
if (heightDefaultBtn) {
  heightDefaultBtn.addEventListener('click', () => {
    heightSlider.value = '1.00';
    setHeightScale('1.00');
  });
}
if (ratioDefaultBtn) {
  ratioDefaultBtn.addEventListener('click', () => {
    ratioSlider.value = '0.65';
    setTopShrink('0.65');
  });
}

video.addEventListener('playing', () => requestAnimationFrame(pump));
window.addEventListener('resize', resizeOverlayToVideo);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { stopStream(); clearOverlay(); }
});
window.addEventListener('pagehide', () => { stopStream(); clearOverlay(); });
