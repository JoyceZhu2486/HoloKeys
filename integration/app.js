// app.js — glue: camera + hands + fingertips + calibration + typing
import * as cam from './camera.js';
import { initHands, detect, refineFingertips } from './fingertips.js';
import {
  MIRROR_PREVIEW, resizeOverlayToVideo, clearOverlay, drawKeyboard,
  drawDebugFJ, drawFingerKeyLabels, buildKeyCells, findKeyAtPoint,
  updateCalibrationFromTips, startCalibration, updateSlidersFromUI, calibState
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

// Editor helpers (ported) so keys can type into the textarea
function focusEditor(){ editor.focus(); }
function setValueAndCaret(text, caretPos){
  const wasFocused = document.activeElement === editor;
  editor.value = text; editor.dispatchEvent(new Event('input', {bubbles:true}));
  if (!wasFocused) editor.focus();
  editor.setSelectionRange(caretPos, caretPos);
}
function insertText(text){
  const { selectionStart, selectionEnd, value } = editor;
  const before = value.slice(0, selectionStart);
  const after  = value.slice(selectionEnd);
  const next = before + text + after;
  const pos = before.length + text.length;
  setValueAndCaret(next, pos);
}
function pressKey(key){
  const { selectionStart, selectionEnd, value } = editor;
  if (key === 'Backspace'){
    if (selectionStart !== selectionEnd){
      setValueAndCaret(value.slice(0, selectionStart) + value.slice(selectionEnd), selectionStart);
    } else if (selectionStart > 0){
      const pos = selectionStart - 1;
      setValueAndCaret(value.slice(0, pos) + value.slice(selectionEnd), pos);
    }
    return;
  }
  if (key === 'Delete'){
    if (selectionStart !== selectionEnd){
      setValueAndCaret(value.slice(0, selectionStart) + value.slice(selectionEnd), selectionStart);
    } else if (selectionStart < value.length){
      setValueAndCaret(value.slice(0, selectionStart) + value.slice(selectionStart+1), selectionStart);
    }
    return;
  }
  if (key === 'Enter'){ insertText('\n'); return; }
  if (key === 'Space'){ insertText(' ');  return; }
  if (typeof key === 'string' && key.length === 1) insertText(key);
}

// UI wiring
btnStartRear.addEventListener('click', async () => { await cam.startRear(); await postStart(); });
btnStartFront.addEventListener('click', async () => { await cam.startFront(); await postStart(); });
btnStop.addEventListener('click', cam.stopStream);
btnSnap.addEventListener('click', async ()=>{
  const blob = await cam.captureJpeg({quality:0.92});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); const ts = new Date().toISOString().replace(/[:.]/g,'-');
  a.href=url; a.download=`frame-${ts}.jpg`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
});
btnRecal.addEventListener('click', () => startCalibration());
chkBlack.addEventListener('change', () => { overlay.style.background = chkBlack.checked ? '#000' : 'transparent'; });

focusEditorBtn.addEventListener('click', ()=>editor.focus());
clearEditorBtn.addEventListener('click', ()=>{ editor.value=''; editor.dispatchEvent(new Event('input')); editor.focus(); });
editor.addEventListener('input', ()=>{ editor.style.height='auto'; editor.style.height=Math.min(editor.scrollHeight, 800)+'px'; });
editor.addEventListener('keydown', (e)=>{ if (e.key==='Tab'){ e.preventDefault(); insertText('  ');} });

// After camera starts
async function postStart(){
  statusEl.textContent = 'Loading model…';
  await initHands();                          // load MediaPipe Hands once
  statusEl.textContent = 'Camera ready';
  startCalibration(); updateSlidersFromUI();

  // Kick the loop
  if (!chkLive.checked) chkLive.checked = true;
}

function doTypingFromTips(tips, quad){
  if (!quad) return;
  const cells = buildKeyCells(quad);
  // Very simple: map index fingertip to a key and type the label
  const idx = tips.find(t => t.finger === 'Index');
  if (!idx) return;
  const hit = findKeyAtPoint(cells, {x:idx.x, y:idx.y});
  if (!hit) return;
  const label = hit.label;

  // Map labels to editor actions (subset)
  if (label === 'Space') { pressKey('Space'); return; }
  if (label === '↩')     { pressKey('Enter'); return; }
  if (label === '⌫')     { pressKey('Backspace'); return; }
  if (label.length === 1){
    // Normalize to printable (letters as-is, others just insert)
    insertText(label.length===1 ? label : '');
  }
}

let lastW=0, lastH=0;
cam.onVideoFrame(()=>{
  if (!chkLive.checked) return;

  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) return;
  if (W!==lastW || H!==lastH){ lastW=W; lastH=H; resizeOverlayToVideo(W,H); }

  const result = detect();
  // draw / update
  clearOverlay();

  // refine tips to overlay coords (convert mirroring here)
  const tips = result ? refineFingertips(result, W, H, MIRROR_PREVIEW) : [];

  // calibration state update using index fingertips as F/J
  updateCalibrationFromTips(tips, performance.now());

  // visuals
  drawKeyboard(calibState.quad);
  drawDebugFJ(calibState.fjCalib?.F, calibState.fjCalib?.J);
  drawFingerKeyLabels(tips, calibState.quad);

  // very-naive typing demo (press when frozen & index is over a key)
  if (calibState.frozen) doTypingFromTips(tips, calibState.quad);
});
