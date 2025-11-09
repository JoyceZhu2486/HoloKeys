// app.js — glue for Version B with Version A slider behavior
import * as cam from './camera.js';
import { initHands, detect, refineFingertips } from './fingertips.js';
import {
  MIRROR_PREVIEW, resizeOverlayToVideo, clearOverlay, drawKeyboard,
  drawFingerKeyLabels, buildKeyCells, findKeyAtPoint,
  setHeightScale, setTopShrink, calibState,
  computeQuadFromAverages,
  drawKeycaps              // <-- add this
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
const editor = document.getElementById('editor');
const focusEditorBtn = document.getElementById('focusEditorBtn');
const clearEditorBtn = document.getElementById('clearEditorBtn');

// Sliders (Version A behavior)
const heightSlider = document.getElementById('height');
const heightVal    = document.getElementById('heightVal');
const ratioSlider  = document.getElementById('ratio');
const ratioVal     = document.getElementById('ratioVal');
const heightDefaultBtn = document.getElementById('heightDefault');
const ratioDefaultBtn  = document.getElementById('ratioDefault');

// --- Editor helpers ---
function focusEditor(){ editor.focus(); }
function setValueAndCaret(text, caretPos){
  const wasFocused = document.activeElement === editor;
  editor.value = text; editor.dispatchEvent(new Event('input', {bubbles:true}));
  if (!wasFocused) editor.blur();
  else editor.setSelectionRange(caretPos, caretPos);
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

// --- Startup ---
(async function main(){
  statusEl.textContent = 'Loading model…';
  try {
    await initHands();
    await cam.listCameras();
    statusEl.textContent = 'Ready. Start camera.';
    btnStartRear.onclick = () => { start(cam.startRear); };
    btnStartFront.onclick= () => { start(cam.startFront); };
    btnStop.onclick = stop;
    cam.camSel.onchange = () => { start(cam.selectDevice, cam.camSel.value); };
    btnSnap.onclick = async () => {
      const blob = await cam.captureJpeg({ quality: 0.9 });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `holokeys_snap_${Date.now()}.jpg`; a.click();
      URL.revokeObjectURL(url);
    };
    chkBlack.onchange = () => { video.style.opacity = chkBlack.checked ? '0' : '1'; };
    btnRecal.onclick = startCalibrationLikeA;

    // === Wire Version A slider behavior ===
    if (heightSlider) {
      setHeightScale(heightSlider.value); // init UI → state
      heightSlider.addEventListener('input', (e)=> setHeightScale(e.target.value));
    }
    if (ratioSlider) {
      setTopShrink(ratioSlider.value); // init UI → state
      ratioSlider.addEventListener('input', (e)=> setTopShrink(e.target.value));
    }
    if (heightDefaultBtn) {
      heightDefaultBtn.addEventListener('click', () => {
        heightSlider.value = '0.60';
        setHeightScale('0.60');
      });
    }
    if (ratioDefaultBtn) {
      ratioDefaultBtn.addEventListener('click', () => {
        ratioSlider.value = '0.74';
        setTopShrink('0.74');
      });
    }

    // Editor buttons
    focusEditorBtn.onclick = focusEditor;
    clearEditorBtn.onclick = () => { setValueAndCaret('', 0); };
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
  }
})();

function startCalibrationLikeA(){
  // Reset averaging state to emulate A’s “Recalibrate”
  calibState.active = true;
  calibState.frozen = false;
  calibState.startMs = 0;
  calibState.F = { x:0, y:0, count:0 };
  calibState.J = { x:0, y:0, count:0 };
  calibState.quad = null;
  statusEl.textContent = 'Calibrating… (place F/J)';
}

async function start(startFn, ...args) {
  btnStartRear.disabled = true; btnStartFront.disabled = true;
  statusEl.textContent = 'Starting camera…';
  try {
    await startFn(...args);
    statusEl.textContent = 'Camera running.';
    btnStop.disabled = false;
    video.style.opacity = '1'; chkBlack.checked = false;
    cam.onVideoFrame(mainLoop);
    startCalibrationLikeA();
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error starting camera: ${err.message}`;
  } finally {
    btnStartRear.disabled = false; btnStartFront.disabled = false;
  }
}

function stop() {
  cam.stopStream();
  clearOverlay();
  statusEl.textContent = 'Stopped.';
  btnStop.disabled = true;
}

// --- Main Loop ---
let lastW=0, lastH=0;
let lastKey = null, lastKeyTime = 0;

function doTyping(tips, quad) {
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

function mainLoop() {
  if (!chkLive.checked) return;
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) return;
  if (W!==lastW || H!==lastH){ lastW=W; lastH=H; resizeOverlayToVideo(W,H); }

  const result = detect();
  clearOverlay();

  const tips = result ? refineFingertips(result, W, H, MIRROR_PREVIEW) : [];

  // Accumulate F/J averages during calibration window
  if (tips && tips.length) {
    const idxTips = tips.filter(t => t.finger === 'Index');
    if (idxTips.length >= 2) {
      const xSorted = idxTips.slice().sort((a, b) => a.x - b.x);
      const F = xSorted[0], J = xSorted[1];
  
      if (!calibState.frozen) {
        // accumulate running averages for 10 s like Version A
        const now = performance.now();
        if (calibState.startMs === 0) calibState.startMs = now;
        calibState.F.x += F.x; calibState.F.y += F.y; calibState.F.count++;
        calibState.J.x += J.x; calibState.J.y += J.y; calibState.J.count++;
        const elapsed = (now - calibState.startMs) / 1000;
        if (elapsed >= 10) {
          calibState.frozen = true;
          statusEl.textContent = 'Frozen';
        } else {
          statusEl.textContent = `Calibrating… ${(10 - elapsed).toFixed(1)}s`;
        }
      }
  
      // live-update the keyboard geometry during calibration
      if (calibState.F.count && calibState.J.count) {
        computeQuadFromAverages();
      }
      // Only allow typing after calibration is frozen (same as A)
      if (calibState.frozen) {
        doTyping(tips, quad);
      }
      const quad = calibState.quad;
      // Outline + row separators (as before)
      drawKeyboard(quad);
      // NEW: draw all key polygons + labels (same visual as A)
      drawKeycaps(quad, { outline: 'rgba(0,255,255,0.9)', lineWidth: 1.5, fill: 'rgba(0,0,0,0.25)', showLabels: true });
      // Optional: keep the floating finger→key pills (A shows finger→key hints)
      drawFingerKeyLabels(tips, quad);
    }
  }

  const quad = calibState.quad;
  drawKeyboard(quad);
  drawFingerKeyLabels(tips, quad);
  doTyping(tips, quad);
}
