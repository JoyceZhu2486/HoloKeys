// app.js — keep B’s camera/hand pipeline; use A’s keyboard geometry & drawing.
// Typing is disabled during calibration; enabled only after freeze.
// Show Hands / Show FJ wired to checkboxes like Version A.

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

// Editor helpers (typing gated until frozen)
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

// Calibration state
let frozen = false;
let calibStartMs = 0;
let sumF = {x:0,y:0,count:0};
let sumJ = {x:0,y:0,count:0};
let quad = null;      // {LB,RB,TR,TL}
let lastFJ = null;    // {F:{x,y}, J:{x,y}} — last frame during calibration

let lastW=0, lastH=0;
let lastKey = null, lastKeyTime = 0;

// Minimal landmarks drawer (checkbox controlled)
function drawHands(result, W, H){
  if (!showHandsChk?.checked) return;
  const hands = result?.landmarks;
  if (!hands?.length) return;

  octx.save();
  if (MIRROR_PREVIEW) { octx.translate(overlay.width, 0); octx.scale(-1, 1); }
  octx.fillStyle = 'rgba(0,255,0,0.9)';
  for (const hand of hands) {
    for (const p of hand) {
      const x = p.x * W, y = p.y * H;
      octx.beginPath(); octx.arc(x, y, 2.5, 0, Math.PI*2); octx.fill();
    }
  }
  octx.restore();
}

// Typing (only after calibration freeze)
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

    // Sliders (A behavior)
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
  drawHands(result, W, H); // respects Show landmarks

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

  // Draw full keyboard & finger→key tooltips
  drawKeyboard(quad);
  drawKeycaps(quad);
  drawFingerKeyLabels(tips, quad);

  // F/J debug crosses (toggle like A)
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

  // Typing only after freeze (match A)
  if (frozen && tips && tips.length) {
    doTyping(tips, quad);
  }
}
