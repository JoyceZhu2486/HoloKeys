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
const recalBtn = document.getElementById('recalibrate');
const statusEl = document.getElementById('status');

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
// Each row: { offset: <left padding in "unit" widths>, keys: [{label, w}] }.
// Units are row-local; we normalize to [0..1] per row so they fit the quad.
// Visual keyboard (bottom → top). Variable-width keys supported.
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
  // (Arrows are rendered inline at the far right for simplicity.)
  { offset: 0,
    keys: [
      {label:'fn',w:1.2},{label:'⌃',w:1.25},{label:'⌥',w:1.5},{label:'⌘',w:1.75},
      {label:'Space',w:6.5},
      {label:'⌘',w:1.75},{label:'⌥',w:1.5},
      {label:'←',w:1},{label:'↑',w:1},{label:'↓',w:1},{label:'→',w:1},
    ]
  },
];



// Tuning
const VERTICAL_SCALE = 1.0;  // vertical pitch relative to horizontal pitch
const TOP_SHRINK = 0.65;     // width_top / width_bottom
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


function rowTotalUnits(row) {
  return (row.offset || 0) + row.keys.reduce((s,k)=>s+(k.w||1), 0);
}
function uCenterInRow(row, keyLabel) {
  const total = rowTotalUnits(row);
  let cur = (row.offset || 0);
  for (const k of row.keys) {
    const w = k.w || 1;
    if (k.label === keyLabel) {
      return (cur + w/2) / total; // fraction [0..1] across THIS row
    }
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


// ---------- Geometry solve so F/J land on HOME row centers ----------
/**
 * Given F and J fingertip points in *screen coords* (already mirrored if preview is),
 * solve the keyboard quad so that the centers of the home-row F and J keys map
 * exactly to those points. Home row stays at v ≈ 0.5 regardless of row count.
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
  const uF = uCenterInRow(homeRow, 'F');
  const uJ = uCenterInRow(homeRow, 'J');
  const deltaU = uJ - uF;                      // F→J span in row-fraction

  // Perspective: top vs bottom width
  const scaleBottom = 1 / TOP_SHRINK;
  const vHome = (homeIdx + 0.5) / R;           // exact vertical center of home row
  const tHome = 1 - vHome;                     // fraction down from top edge
  const sHome = 1 + tHome * (scaleBottom - 1); // horizontal scale at home row vs top

  // Top width so that F↔J at home row matches measured separation
  const wTop = sep / (sHome * Math.max(1e-6, deltaU));

  // Vertical pitch: use "one unit" width on the home row as reference
  const unitsHome = rowTotalUnits(homeRow);    // sum(offset + widths) on home row
  const oneUnitOnHome = (sHome * wTop) / unitsHome;
  const uy = oneUnitOnHome * VERTICAL_SCALE;   // per-row vertical step
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
  for (let i = 1; i < points.length; i++) octx.lineTo(points[i].x, points[i].y);
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


function drawKeyboard(q){
  if (!q) return;

  // Estimate key height using the home-row band center
  const R = ROWS.length;
  const homeRowIdx = ROWS.findIndex(row => row.keys.some(k => k.label === 'F'));
  const vBandTop = (homeRowIdx + 2/3) / R;
  const vBandBot = (homeRowIdx + 1/3) / R;
  const pTop = mapRectToQuad(0.5, vBandTop, q);
  const pBot = mapRectToQuad(0.5, vBandBot, q);
  const keyHeightPx = Math.hypot(pTop.x - pBot.x, pTop.y - pBot.y);
  const labelSize = keyHeightPx * 0.45;

  // Draw rows, bottom → top
  for (let r = 0; r < R; r++) {
    const row = ROWS[r];
    const vBot = r / R;
    const vTop = (r + 1) / R;

    // Row normalization to [0..1]
    const totalW = (row.offset || 0) + row.keys.reduce((s,k)=>s+(k.w||1), 0);
    let cursor = row.offset || 0;

    for (const k of row.keys) {
      const w = k.w || 1;
      const u0 = cursor / totalW;
      const u1 = (cursor + w) / totalW;

      // 4 corners of the key cell in screen space
      const p0 = mapRectToQuad(u0, vTop, q); // TL
      const p1 = mapRectToQuad(u1, vTop, q); // TR
      const p2 = mapRectToQuad(u1, vBot, q); // BR
      const p3 = mapRectToQuad(u0, vBot, q); // BL

      // Styling
      const special = isSpecial(k.label);
      octx.lineWidth = special ? 2 : 1.25;
      octx.strokeStyle = special ? 'rgba(0,120,0,0.95)' : 'rgba(0,128,255,0.6)';
      octx.fillStyle   = special ? 'rgba(0,120,0,0.08)' : 'rgba(0,128,255,0.08)';

      // Outline & fill
      drawPolygon([p0, p1, p2, p3]);
      octx.fill();

      // Label (overlay not mirrored)
      octx.fillStyle = '#0a0a0a';
      drawLabelAtCenter([p0,p1,p2,p3], k.label, labelSize);

      // Emphasize F/J
      if (k.label === 'F' || k.label === 'J') {
        octx.strokeStyle = 'rgba(0,200,0,0.95)';
        octx.lineWidth = 2.25;
        drawPolygon([p0,p1,p2,p3]);
      }

      cursor += w;
    }
  }

  // Debug: fingertip crosses
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
function updateBlackMode() {
  overlay.style.background = blackChk.checked ? '#000' : 'transparent';
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

startBtn.addEventListener('click', async () => {
  await startStreamWith({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } },
    audio: false
  });
});
camSel.addEventListener('change', async () => {
  currentDeviceId = camSel.value;
  await startStreamWith({ video: { deviceId: { exact: currentDeviceId } }, audio: false });
});
stopBtn.addEventListener('click', () => { stopStream(); clearOverlay(); });
snapBtn.addEventListener('click', downloadSnapshot);
blackChk.addEventListener('change', updateBlackMode);
recalBtn.addEventListener('click', () => { startCalibration(); });

video.addEventListener('playing', () => requestAnimationFrame(pump));
window.addEventListener('resize', resizeOverlayToVideo);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { stopStream(); clearOverlay(); }
});
window.addEventListener('pagehide', () => { stopStream(); clearOverlay(); });
