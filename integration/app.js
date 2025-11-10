// app.js — integrated build with A-style keyboard + EXACT landmark & fingertip display from fingertip_detection.html

import * as cam from './camera.js';
import { initHands, detect, refineFingertips } from './fingertips.js';
import {
  MIRROR_PREVIEW, resizeOverlayToVideo, clearOverlay,
  drawKeyboard, drawKeycaps, drawFingerKeyLabels,
  buildKeyCells, findKeyAtPoint,
  setHeightScale, setTopShrink, computeQuadFromFJ
} from './calibration.js';

// UI
const statusEl = document.getElementById('status');
const btnStartRear = document.getElementById('btnStartRear');
const btnStartFront= document.getElementById('btnStartFront');
const btnStop      = document.getElementById('btnStop');
const btnSnap      = document.getElementById('btnSnap');
const chkLive      = document.getElementById('chkLive');
const chkBlack     = document.getElementById('chkBlack');
const overlay      = document.getElementById('overlay');
const video        = document.getElementById('video');
const btnRecal     = document.getElementById('btnRecal');
const showHandsChk = document.getElementById('showHands');
const showDebugChk = document.getElementById('showDebug');

const octx = overlay.getContext('2d');

const heightSlider = document.getElementById('height');
const ratioSlider  = document.getElementById('ratio');
const heightDefaultBtn = document.getElementById('heightDefault');
const ratioDefaultBtn  = document.getElementById('ratioDefault');

const editor = document.getElementById('editor');
const focusEditorBtn = document.getElementById('focusEditorBtn');
const clearEditorBtn = document.getElementById('clearEditorBtn');

// Hidden frame canvas for pixel reads (same as fingertip_detection.html)
const tempCanvas = document.getElementById('tempCanvas');
const tctx = tempCanvas.getContext('2d');

// --- Landmark & Fingertip Display: EXACT methods from fingertip_detection.html ---

// MediaPipe connections
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],       // Thumb
  [0,5],[5,6],[6,7],[7,8],       // Index
  [0,9],[9,10],[10,11],[11,12],  // Middle
  [0,13],[13,14],[14,15],[15,16],// Ring
  [0,17],[17,18],[18,19],[19,20] // Pinky
];

// Fingertip map (tip index → base joint + label)
const FINGERTIP_MAP = {
  4:  { name: "Thumb",  base: 3,  color: '#3b82f6' },
  8:  { name: "Index",  base: 7,  color: '#22c55e' },
  12: { name: "Middle", base: 11, color: '#22d3ee' },
  16: { name: "Ring",   base: 15, color: '#f97316' },
  20: { name: "Pinky",  base: 19, color: '#ec4899' }
};

// Colors/params (kept identical)
const FALLBACK_COLOR = '#dc2626'; // red for M2 fallback
const GRADIENT_COLOR = '#3b82f6'; // blue for M5 success
const DEFAULT_TIP_COLOR = '#f97316';

const M5_MAX_SEARCH_DIST = 30;
const M5_LOOKAHEAD = 5;
const M5_MIN_SUCCESS_DIST = 5;
const GRADIENT_THRESHOLD = 30;
const EXTENSION_FACTOR = 0.35;

// Color helpers (exact)
function rgbToHsl(r, g, b) {
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h,s,l=(max+min)/2;
  if (max===min){ h=s=0; }
  else {
    const d=max-min;
    s = l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h=(g-b)/d + (g<b?6:0); break;
      case g: h=(b-r)/d + 2; break;
      case b: h=(r-g)/d + 4; break;
    }
    h/=6;
  }
  return [h*360, s, l];
}
function calculateColorDifference(r1,g1,b1,r2,g2,b2){
  const diffR=(r1-r2)/255, diffG=(g1-g2)/255, diffB=(b1-b2)/255;
  const rgbDist=Math.sqrt(diffR*diffR+diffG*diffG+diffB*diffB);
  const [h1,s1,l1]=rgbToHsl(r1,g1,b1), [h2,s2,l2]=rgbToHsl(r2,g2,b2);
  let diffH=Math.abs(h1-h2); if (diffH>180) diffH=360-diffH; diffH/=180;
  const diffS=Math.abs(s1-s2), diffL=Math.abs(l1-l2);
  return (rgbDist*0.5) + (diffH*0.25) + (diffS*0.125) + (diffL*0.125);
}

// ROI from tip→base projection (exact)
function calculateFingertipROI(landmarks, tipIndex, baseIndex){
  if (!landmarks || landmarks.length<=tipIndex || landmarks.length<=baseIndex) return null;
  const tip=landmarks[tipIndex], base=landmarks[baseIndex];
  const w=overlay.width, h=overlay.height;
  const pTip={x:tip.x*w, y:tip.y*h}, pBase={x:base.x*w, y:base.y*h};
  const vecX=pTip.x-pBase.x, vecY=pTip.y-pBase.y;
  const length=Math.sqrt(vecX*vecX+vecY*vecY);
  if (length<1) return null;
  const unitX=vecX/length, unitY=vecY/length;
  const proportionalExtension=length*EXTENSION_FACTOR;
  const pProjection={ x:pTip.x+unitX*proportionalExtension, y:pTip.y+unitY*proportionalExtension };
  return {
    landmarkTipX:pTip.x, landmarkTipY:pTip.y,
    projectionX:pProjection.x, projectionY:pProjection.y,
    tipX:pTip.x, tipY:pTip.y, unitX, unitY
  };
}

// Gradient search along projection (exact; draws dashed line)
function findGradientTip(roiData){
  const videoW=video.videoWidth, videoH=video.videoHeight;
  tempCanvas.width=videoW; tempCanvas.height=videoH;
  tctx.drawImage(video, 0, 0, videoW, videoH);
  const imageData=tctx.getImageData(0, 0, videoW, videoH);
  const data=imageData.data;

  const { tipX, tipY, unitX, unitY, projectionX, projectionY }=roiData;
  let finalPoint=null;

  octx.save();
  octx.strokeStyle=GRADIENT_COLOR;
  octx.lineWidth=2;
  octx.setLineDash([5,5]);
  octx.beginPath();
  octx.moveTo(tipX, tipY);

  for (let dist=1; dist<M5_MAX_SEARCH_DIST; dist+=1){
    const currentX=Math.round(tipX+unitX*dist);
    const currentY=Math.round(tipY+unitY*dist);
    if (currentX<0||currentX>=videoW||currentY<0||currentY>=videoH) break;
    const lookAheadX=Math.round(tipX+unitX*(dist+M5_LOOKAHEAD));
    const lookAheadY=Math.round(tipY+unitY*(dist+M5_LOOKAHEAD));
    if (lookAheadX<0||lookAheadX>=videoW||lookAheadY<0||lookAheadY>=videoH) break;

    const idx=(currentY*videoW+currentX)*4;
    const idx2=(lookAheadY*videoW+lookAheadX)*4;
    if (idx+2>=data.length||idx2+2>=data.length) break;

    const r1=data[idx], g1=data[idx+1], b1=data[idx+2];
    const r2=data[idx2], g2=data[idx2+1], b2=data[idx2+2];
    const gradient=calculateColorDifference(r1,g1,b1,r2,g2,b2)*255; // their function returns 0..1; *255 to match threshold scale

    if (gradient>GRADIENT_THRESHOLD){
      if (dist>M5_MIN_SUCCESS_DIST){
        finalPoint={x:currentX, y:currentY, source:'Gradient (M5)'};
        break;
      }
    }
  }

  if (!finalPoint){
    finalPoint={x:projectionX, y:projectionY, source:'Fallback (M2)'};
    octx.lineTo(finalPoint.x, finalPoint.y);
  } else {
    octx.lineTo(finalPoint.x, finalPoint.y);
  }
  octx.stroke();
  octx.setLineDash([]);
  octx.restore();

  return finalPoint;
}

// Draw skeleton (gray) exactly like fingertip_detection.html
function drawHandLandmarks(landmarks){
  const w=overlay.width, h=overlay.height;
  // connections
  octx.save();
  if (MIRROR_PREVIEW){ octx.translate(overlay.width,0); octx.scale(-1,1); }
  octx.strokeStyle='#666'; octx.lineWidth=1;
  octx.beginPath();
  HAND_CONNECTIONS.forEach(([a,b])=>{
    const s=landmarks[a], e=landmarks[b];
    octx.moveTo(s.x*w, s.y*h); octx.lineTo(e.x*w, e.y*h);
  });
  octx.stroke();
  // points
  octx.fillStyle='#666';
  for (const p of landmarks){
    octx.beginPath(); octx.arc(p.x*w, p.y*h, 4, 0, Math.PI*2); octx.fill();
  }
  octx.restore();
}

// Draw final fingertip marker + label (exact)
function drawFinalTip(point, name){
  const markerColor = point.source.includes('Fallback') ? FALLBACK_COLOR : GRADIENT_COLOR;
  octx.save();
  octx.fillStyle=markerColor;
  octx.beginPath(); octx.arc(point.x, point.y, 10, 0, Math.PI*2); octx.fill();
  octx.strokeStyle='#111'; octx.lineWidth=2; octx.stroke();
  octx.fillStyle='#fff'; octx.font='bold 14px system-ui';
  octx.fillText(name, point.x+15, point.y+5);
  octx.restore();
}

// ---------------- Existing typing/editor helpers ----------------
function focusEditor(){ editor.focus(); }
function setValueAndCaret(text, caretPos){
  const wasFocused = document.activeElement === editor;
  editor.value = text; editor.dispatchEvent(new Event('input', {bubbles:true}));
  if (!wasFocused) editor.blur(); else editor.setSelectionRange(caretPos, caretPos);
}
function insertText(newText) {
  focusEditor();
  const s = editor.selectionStart, e = editor.selectionEnd;
  const val = editor.value;
  const text = val.substring(0, s) + newText;
  const rest = val.substring(e);
  setValueAndCaret(text + rest, text.length);
}
function pressKey(key) {
  focusEditor();
  const s = editor.selectionStart, e = editor.selectionEnd;
  const val = editor.value;
  let text = val.substring(0, s);
  let rest = val.substring(e);
  if (key === 'Backspace') {
    if (s === e && s > 0) { text = val.substring(0, s - 1); }
    setValueAndCaret(text + rest, text.length);
  } else if (key === 'Enter') {
    insertText('\n');
  } else if (key === 'Space') {
    insertText(' ');
  }
}

// Calibration state (unchanged)
let frozen = false;
let calibStartMs = 0;
let sumF = {x:0,y:0,count:0};
let sumJ = {x:0,y:0,count:0};
let quad = null;      // {LB,RB,TR,TL}
let lastFJ = null;    // last frame F/J during calibration

let lastW=0, lastH=0;
let lastKey = null, lastKeyTime = 0;

function doTyping(tips, quad){
  if (!quad) return;
  const cells = buildKeyCells(quad);
  const idx = tips.find(t => t.finger === 'Index');
  if (!idx) return;
  const hit = findKeyAtPoint(cells, {x:idx.x, y:idx.y});
  if (!hit) { lastKey = null; return; }
  const label = hit.label;
  const now = performance.now();
  if (label === lastKey && (now - lastKeyTime) < 120) return;
  lastKey = label; lastKeyTime = now;
  if (label === 'Space') { pressKey('Space'); return; }
  if (label === '↩')     { pressKey('Enter'); return; }
  if (label === '⌫')     { pressKey('Backspace'); return; }
  if (label.length === 1){ insertText(label); }
}

(async function main(){
  statusEl.textContent = 'Loading model…';
  try {
    await initHands();
    await cam.listCameras();
    statusEl.textContent = 'Ready. Start camera.';
    btnStartRear.onclick = () => start(cam.startRear);
    btnStartFront.onclick= () => start(cam.startFront);
    cam.camSel.onchange  = () => start(cam.selectDevice, cam.camSel.value);
    btnStop.onclick      = stop;
    btnSnap.onclick = async () => {
      const blob = await cam.captureJpeg({ quality: 0.9 });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `holokeys_${Date.now()}.jpg`; a.click();
      URL.revokeObjectURL(url);
    };
    chkBlack.onchange = () => { video.style.opacity = chkBlack.checked ? '0' : '1'; };
    btnRecal.onclick  = startCalibration;

    // Sliders
    setHeightScale(heightSlider.value);
    setTopShrink(ratioSlider.value);
    heightSlider.addEventListener('input', e => { setHeightScale(e.target.value); if (frozen) recomputeFromAverages(); });
    ratioSlider .addEventListener('input', e => { setTopShrink(e.target.value); if (frozen) recomputeFromAverages(); });
    heightDefaultBtn.addEventListener('click', () => { heightSlider.value='0.60'; setHeightScale('0.60'); if (frozen) recomputeFromAverages(); });
    ratioDefaultBtn .addEventListener('click', () => { ratioSlider.value='0.74'; setTopShrink('0.74'); if (frozen) recomputeFromAverages(); });

    // Editor helpers
    focusEditorBtn.onclick = () => editor.focus();
    clearEditorBtn.onclick = () => setValueAndCaret('', 0);
  } catch (e) {
    console.error(e);
    statusEl.textContent = `Error: ${e.message}`;
  }
})();

function startCalibration(){
  frozen = false;
  calibStartMs = 0;
  sumF = {x:0,y:0,count:0};
  sumJ = {x:0,y:0,count:0};
  quad = null;
  lastFJ = null;
  statusEl.textContent = 'Calibrating… (place index fingertips on F and J)';
}

async function start(startFn, ...args){
  btnStartRear.disabled = true; btnStartFront.disabled = true;
  statusEl.textContent = 'Starting camera…';
  try{
    await startFn(...args);
    statusEl.textContent = 'Camera running.';
    btnStop.disabled = false;
    video.style.opacity = '1'; chkBlack.checked = false;
    cam.onVideoFrame(mainLoop);
    startCalibration();
  } catch(e) {
    console.error(e);
    statusEl.textContent = `Error starting camera: ${e.message}`;
  } finally {
    btnStartRear.disabled = false; btnStartFront.disabled = false;
  }
}

function stop(){
  cam.stopStream();
  clearOverlay();
  statusEl.textContent = 'Stopped.';
  btnStop.disabled = true;
}

function recomputeFromAverages(){
  if (sumF.count && sumJ.count){
    const F = { x: sumF.x / sumF.count, y: sumF.y / sumF.count };
    const J = { x: sumJ.x / sumJ.count, y: sumJ.y / sumJ.count };
    quad = computeQuadFromFJ(F, J);
  }
}

function mainLoop(){
  if (!chkLive.checked) return;
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) return;

  if (W!==lastW || H!==lastH){ lastW=W; lastH=H; resizeOverlayToVideo(W,H); }

  const result = detect();

  clearOverlay();

  // === Landmark + Fingertip display (from fingertip_detection.html) ===
  const hands = result?.landmarks || [];
  for (const handLandmarks of hands){
    if (showHandsChk?.checked) drawHandLandmarks(handLandmarks); // skeleton/points

    // Fingertips with gradient search & dashed projection
    for (const tipIndexStr in FINGERTIP_MAP){
      const tipIndex = parseInt(tipIndexStr, 10);
      const cfg = FINGERTIP_MAP[tipIndex];
      const roi = calculateFingertipROI(handLandmarks, tipIndex, cfg.base);
      if (!roi) continue;
      const finalTip = findGradientTip(roi);
      if (finalTip) drawFinalTip(finalTip, cfg.name);
    }
  }

  const tips = result ? refineFingertips(result, W, H, MIRROR_PREVIEW) : [];

  // During calibration: follow fingertips instantly and accumulate averages
  if (!frozen && tips && tips.length){
    const idx = tips.filter(t=>t.finger==='Index').sort((a,b)=>a.x-b.x);
    if (idx.length >= 2){
      const F = idx[0], J = idx[idx.length-1];
      lastFJ = { F:{x:F.x,y:F.y}, J:{x:J.x,y:J.y} };

      // live quad so the keyboard follows fingers (A behavior)
      quad = computeQuadFromFJ({x:F.x,y:F.y},{x:J.x,y:J.y});

      // start timer on first valid quad
      const now = performance.now();
      if (!calibStartMs) calibStartMs = now;

      // accumulate averages for the eventual freeze
      sumF.x += F.x; sumF.y += F.y; sumF.count++;
      sumJ.x += J.x; sumJ.y += J.y; sumJ.count++;

      const elapsed = (now - calibStartMs)/1000;
      if (elapsed >= 10) {
        frozen = true;
        recomputeFromAverages(); // lock to averaged F/J
        statusEl.textContent = 'Frozen';
      } else {
        statusEl.textContent = `Calibrating… ${(10 - elapsed).toFixed(1)}s`;
      }
    }
  }

  // Draw keyboard & overlays
  drawKeyboard(quad);
  drawKeycaps(quad);
  drawFingerKeyLabels(tips, quad);

  // F/J debug crosses (toggle)
  if (showDebugChk?.checked) {
    const drawX = (pt, r=6) => {
      octx.beginPath();
      octx.moveTo(pt.x - r, pt.y - r); octx.lineTo(pt.x + r, pt.y + r);
      octx.moveTo(pt.x + r, pt.y - r); octx.lineTo(pt.x - r, pt.y + r);
      octx.stroke();
    };
    octx.save();
    octx.strokeStyle = 'rgba(0,255,255,0.95)';
    octx.lineWidth = 2;
    if (frozen && sumF.count && sumJ.count) {
      const F = { x: sumF.x / sumF.count, y: sumF.y / sumF.count };
      const J = { x: sumJ.x / sumJ.count, y: sumJ.y / sumJ.count };
      drawX(F); drawX(J);
    } else if (lastFJ) {
      drawX(lastFJ.F); drawX(lastFJ.J);
    }
    octx.restore();
  }

  // Typing only after freeze
  if (frozen && tips && tips.length) {
    doTyping(tips, quad);
  }
}
