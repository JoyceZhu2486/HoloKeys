// app.js — integrated fingertips + tap detection.
// Typing is disabled during calibration; enabled only after freeze.

import * as cam from './camera.js';
import { initHands, detect, refineFingertips } from './fingertips.js';
import {
  MIRROR_PREVIEW, resizeOverlayToVideo, clearOverlay,
  drawKeyboard, drawKeycaps, drawFingerKeyLabels,
  buildKeyCells, findKeyAtPoint,
  setHeightScale, setTopShrink, computeQuadFromFJ
} from './calibration.js';

import {
  initTapDetection,
  updateTapFromLandmarks,
  runTapDetectionFrame,
  setTapThresholds
} from './tap.js';
import { connectPressureSensors } from './pressure.js';

// ---------- UI refs ----------

const statusEl = document.getElementById('status');
const btnStartRear = document.getElementById('btnStartRear');
const btnStartFront = document.getElementById('btnStartFront');
const btnStop = document.getElementById('btnStop');
const btnSnap = document.getElementById('btnSnap');
const chkBlack = document.getElementById('chkBlack');

const showHandsChk = document.getElementById('showHands');
const showDebugChk = document.getElementById('showDebug');
const showTipLogChk = document.getElementById('showTipLog');
const showTapLogChk = document.getElementById('showTapLog');
const tipLogPanel = document.getElementById('tipLogPanel');
const contactLogEl = document.getElementById('contactLog');
const btnRecal = document.getElementById('btnRecal');
const tapTypingModeChk = document.getElementById('tapTypingMode');

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');

const stageWrap = document.getElementById('stageWrap');
const tapList = document.getElementById('tapList');

// We will use this as the single "Save all logs" button.
const btnExportTapLog = document.getElementById('btnExportTapLog');
// btnExportMotionLog exists in HTML but is unused now (one-button export).

const heightSlider = document.getElementById('height');
const ratioSlider = document.getElementById('ratio');
const heightDefaultBtn = document.getElementById('heightDefault');
const ratioDefaultBtn = document.getElementById('ratioDefault');

const editor = document.getElementById('editor');
const focusEditorBtn = document.getElementById('focusEditorBtn');
const clearEditorBtn = document.getElementById('clearEditorBtn');
const btnConnectPressureLeft = document.getElementById('btnConnectPressureLeft');
const btnConnectPressureRight = document.getElementById('btnConnectPressureRight');
const pressureStatusLeft = document.getElementById('pressureStatusLeft');
const pressureStatusRight = document.getElementById('pressureStatusRight');

const inputSpeedThreshold = document.getElementById('inputSpeedThreshold');
const inputDistanceThreshold = document.getElementById('inputDistanceThreshold');
const inputScoreThreshold = document.getElementById('inputScoreThreshold');

// ---------- Constants ----------

// Hand skeleton connections (MediaPipe standard)
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],        // Thumb
  [0, 5], [5, 6], [6, 7], [7, 8],        // Index
  [0, 9], [9, 10], [10, 11], [11, 12],   // Middle
  [0, 13], [13, 14], [14, 15], [15, 16], // Ring
  [0, 17], [17, 18], [18, 19], [19, 20]  // Pinky
];

// Fingertip marker colors
const TIP_COLOR_GRADIENT = '#3b82f6'; // M5 success
const TIP_COLOR_FALLBACK = '#dc2626'; // M5 -> M2 fallback

const FINGER_LANDMARK_BY_NAME = {
  Thumb: 4,
  Index: 8,
  Middle: 12,
  Ring: 16,
  Pinky: 20
};
const SENSOR_FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];

// Storage keys for tap thresholds
const SPEED_STORAGE_KEY = 'tapVelocityThreshold';
const DISTANCE_STORAGE_KEY = 'tapMinTapDistance';
const SCORE_STORAGE_KEY = 'tapScoreThreshold';

// Currently highlighted key (for tap feedback)
let highlightedKeyLabel = null;
let highlightedKeyUntilMs = 0;

// ---------- Editor helpers ----------

function focusEditor() { editor?.focus(); }

function setValueAndCaret(text, caretPos) {
  if (!editor) return;
  const wasFocused = document.activeElement === editor;
  editor.value = text;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  if (!wasFocused) editor.blur();
  else editor.setSelectionRange(caretPos, caretPos);
}

function insertText(newText) {
  if (!editor) return;
  focusEditor();
  const s = editor.selectionStart, e = editor.selectionEnd;
  const val = editor.value;
  const text = val.substring(0, s) + newText;
  const rest = val.substring(e);
  setValueAndCaret(text + rest, text.length);
}

function pressKey(key) {
  if (!editor) return;
  focusEditor();
  const s = editor.selectionStart, e = editor.selectionEnd;
  const val = editor.value;
  let text = val.substring(0, s);
  const rest = val.substring(e);
  if (key === 'Backspace') {
    if (s === e && s > 0) {
      text = val.substring(0, s - 1);
    }
    setValueAndCaret(text + rest, text.length);
  } else if (key === 'Enter') {
    insertText('\n');
  } else if (key === 'Space') {
    insertText(' ');
  }
}

function setPressureStatus(el, msg) {
  if (el) el.textContent = msg;
}

// ---------- Calibration / typing state ----------

// Calibration state
let frozen = false;
let calibStartMs = 0;

// During calibration, we keep a sliding window (~last 1s) of F/J positions.
let fjSamples = [];          // each { xF, yF, xJ, yJ, t }
let frozenF = null;          // averaged F from last 1s at freeze time
let frozenJ = null;          // averaged J from last 1s at freeze time

let quad = null;      // {LB,RB,TR,TL}
let lastFJ = null;    // {F:{x,y}, J:{x,y}} — last frame during calibration

let lastW = 0, lastH = 0;
let lastKey = null, lastKeyTime = 0;

// Latest raw hand landmarks (normalized coordinates) for tap mapping
let lastHandsForTap = [];

// Latest refined fingertip positions (overlay coordinates) for tap mapping
let lastTipsForTap = [];

// ---------- Typing & tap logs ----------

let typingLog = [];              // { timeMs, timeAbsMs, label, source, x, y, handIndex, finger }
let typingSessionStartMs = null; // set when calibration finishes

// Tap candidate log (for threshold tuning)
let tapCandidateLog = [];  // { ... from logTapCandidate }

// Fingertip motion log for index finger (per-frame samples, for plotting)
let fingertipMotionLog = [];   // { t, handIndex, x_raw, y_raw, x_refined, y_refined, tapCandidate }

// FSM phase-change events from tap.js
let tapPhaseEvents = [];       // { handIndex, fingerIndex, fromPhase, toPhase, timestamp }

// NEW: tap → text latency log (per character typed by tap)
let tapLatencyLog = [];
// each entry:
// {
//   label, handIndex, fingerIndex, fingerName,
//   tapTimestamp, tapDetectedAt, typeCallStartedAt, typedAt,
//   latencyFromDetectionMs, latencyFromTapTimestampMs
// }

// Pressure sensor stream cleanup
let stopPressureLeft = null;
let stopPressureRight = null;

// ---------- Drawing helpers ----------

function drawHands(result, W, H) {
  if (!showHandsChk?.checked) return;
  const hands = result?.landmarks;
  if (!hands?.length) return;

  octx.save();
  if (MIRROR_PREVIEW) {
    octx.translate(overlay.width, 0);
    octx.scale(-1, 1);
  }

  const w = overlay.width;
  const h = overlay.height;

  // Draw hand skeleton connections
  octx.strokeStyle = '#666';
  octx.lineWidth = 1;
  for (const hand of hands) {
    octx.beginPath();
    for (const [startIdx, endIdx] of HAND_CONNECTIONS) {
      const start = hand[startIdx];
      const end = hand[endIdx];
      if (!start || !end) continue;
      const startX = start.x * w;
      const startY = start.y * h;
      const endX = end.x * w;
      const endY = end.y * h;
      octx.moveTo(startX, startY);
      octx.lineTo(endX, endY);
    }
    octx.stroke();

    // Draw landmarks as small dots
    octx.fillStyle = '#666';
    for (const p of hand) {
      const x = p.x * w;
      const y = p.y * h;
      octx.beginPath();
      octx.arc(x, y, 3, 0, Math.PI * 2);
      octx.fill();
    }
  }

  octx.restore();
}

function drawFingertipMarkers(tips) {
  if (!showHandsChk?.checked) return;
  if (!tips || !tips.length) return;

  octx.save();
  // tips are already in preview space, so no extra MIRROR transform
  for (const tip of tips) {
    const isFallback = typeof tip.source === 'string' && tip.source.includes('Fallback');
    const color = isFallback ? TIP_COLOR_FALLBACK : TIP_COLOR_GRADIENT;

    octx.fillStyle = color;
    octx.beginPath();
    octx.arc(tip.x, tip.y, 8, 0, Math.PI * 2);
    octx.fill();

    octx.strokeStyle = 'rgba(0,0,0,0.85)';
    octx.lineWidth = 2;
    octx.stroke();

    if (tip.finger) {
      const label = tip.handLabel ? `${tip.handLabel[0]}-${tip.finger}` : tip.finger;
      octx.fillStyle = 'rgba(0,0,0,0.8)';
      octx.font = 'bold 12px system-ui, -apple-system, sans-serif';
      octx.fillText(label, tip.x + 10, tip.y + 4);
    }
  }
  octx.restore();
}

// Highlight the key that was tapped (short flash)
function drawTapKeyHighlight(q) {
  if (!q || !highlightedKeyLabel) return;

  const now = performance.now();
  if (now > highlightedKeyUntilMs) {
    // Highlight expired
    highlightedKeyLabel = null;
    return;
  }

  const cells = buildKeyCells(q);
  const hit = cells.find(c => c.label === highlightedKeyLabel);
  if (!hit) return;

  octx.save();
  octx.beginPath();
  octx.moveTo(hit.poly[0].x, hit.poly[0].y);
  for (let i = 1; i < hit.poly.length; i++) {
    octx.lineTo(hit.poly[i].x, hit.poly[i].y);
  }
  octx.closePath();

  // Semi-transparent fill + bright border
  octx.fillStyle   = 'rgba(255, 230, 0, 0.25)';
  octx.strokeStyle = 'rgba(255, 210, 0, 0.9)';
  octx.lineWidth   = 3;
  octx.fill();
  octx.stroke();
  octx.restore();
}

function updateTipLog(result, tips) {
  if (!showTipLogChk) return;

  if (!showTipLogChk.checked) {
    if (tipLogPanel) tipLogPanel.style.display = 'none';
    return;
  }

  if (!tipLogPanel || !contactLogEl) return;
  tipLogPanel.style.display = 'block';

  const hands = result?.landmarks || [];
  const handedness = result?.handedness || [];

  if (!hands.length || !tips || !tips.length) {
    contactLogEl.textContent = 'No hands / fingertips detected.';
    return;
  }

  let html = '';
  for (let hi = 0; hi < hands.length; hi++) {
    const handLabel = (handedness[hi]?.[0]?.categoryName) || 'Unknown'; // Left / Right
    html += `<div class="log-hand-label">Hand ${hi + 1} (${handLabel})</div>`;

    const handTips = tips.filter(t => t.handIndex === hi);
    if (!handTips.length) {
      html += `<div class="log-line">- No fingertips detected</div>`;
      continue;
    }

    for (const tip of handTips) {
      const isFallback = typeof tip.source === 'string' && tip.source.includes('Fallback');
      const cls = isFallback ? 'fallback-text' : 'gradient-text';
      const srcShort = isFallback ? 'Fallback' : 'Gradient';
      const x = tip.x.toFixed(1);
      const y = tip.y.toFixed(1);
      const finger = tip.finger || 'Finger';

      html += `<div class="log-line ${cls}">- ${finger} (${srcShort}): x=${x}, y=${y}</div>`;
    }
  }

  contactLogEl.innerHTML = html;
}

function typeKeyLabel(label, source, meta) {
  const now = performance.now();

  // Shared debounce for both hover + tap so we don't double-type
  if (label === lastKey && (now - lastKeyTime) < 120) return;
  lastKey = label;
  lastKeyTime = now;

  // If this key came from a TAP event, flash the key on the overlay
  if (source === 'tap') {
    highlightedKeyLabel   = label;
    highlightedKeyUntilMs = now + 180; // ms to show highlight
  }

  // Logging
  const tRel = (typingSessionStartMs != null)
    ? (now - typingSessionStartMs)
    : now;

  const x         = meta?.x ?? null;
  const y         = meta?.y ?? null;
  const handIndex = meta?.handIndex ?? null;
  const finger    = meta?.finger ?? null;

  typingLog.push({
    timeMs: tRel,
    timeAbsMs: now,
    label,
    source,            // "hover" or "tap"
    x, y,
    handIndex,
    finger
  });

  // Actual key behavior (same as your existing doTyping)
  if (label === 'Space') {
    pressKey('Space');
    return;
  }
  if (label === '↩') {
    pressKey('Enter');
    return;
  }
  if (label === '⌫') {
    pressKey('Backspace');
    return;
  }
  if (label.length === 1) {
    insertText(label);
  }
}

function doTyping(tips, quad){
  if (!quad) return;
  const cells = buildKeyCells(quad);
  const idx = tips.find(t => t.finger === 'Index');
  if (!idx) return;

  const hit = findKeyAtPoint(cells, {x: idx.x, y: idx.y});
  if (!hit) { lastKey = null; return; }

  const label = hit.label;

  // Use unified helper for logging + key effect
  typeKeyLabel(label, 'hover', {
    x: idx.x,
    y: idx.y,
    handIndex: idx.handIndex,
    finger: idx.finger || null
  });
}

// Pressure-sensor taps feed into the same tap → key path
function handlePressureTap(evt) {
  if (!frozen) return; // needs calibrated keyboard + tracked fingertips

  const fingerName =
    evt?.fingerName ||
    SENSOR_FINGER_NAMES[evt?.sensorIndex] ||
    'Index';

  const fingerIndex =
    evt?.fingerIndex ??
    FINGER_LANDMARK_BY_NAME[fingerName] ??
    8;

  const handIndex =
    (evt && typeof evt.handIndex === 'number')
      ? evt.handIndex
      : 0;

  setPressureStatus(pressureStatusLeft, `${fingerName}: tap`);
  setPressureStatus(pressureStatusRight, `${fingerName}: tap`);

  const tapEvent = {
    id: `pressure-${Date.now()}`,
    timestamp: performance.now(),
    handIndex,
    fingerIndex,
    fingerName
  };

  flashTapBorder(tapEvent);
}

// Convert a tapEvent's fingertip to overlay pixel coordinates
function getTapOverlayPoint(tapEvent) {
  if (!overlay) return null;
  const { handIndex, fingerIndex, fingerName } = tapEvent;
  if (handIndex == null || fingerIndex == null) return null;

  // 1) Prefer refined fingertips from the last frame
  if (lastTipsForTap && lastTipsForTap.length) {
    const targetName = fingerName || null;

    let tip = null;
    if (targetName) {
      tip = lastTipsForTap.find(t =>
        t.handIndex === handIndex &&
        (t.finger === targetName || t.fingerName === targetName)
      );
    }

    // If name match failed, try matching by handIndex + landmark index
    if (!tip) {
      tip = lastTipsForTap.find(t =>
        t.handIndex === handIndex &&
        t.landmarkIndex === fingerIndex
      );
    }

    // If still nothing, try any hand with the same finger name (MediaPipe ordering can flip)
    if (!tip && targetName) {
      tip = lastTipsForTap.find(t =>
        (t.finger === targetName || t.fingerName === targetName)
      );
    }

    // Last resort: any tip with matching landmark index
    if (!tip) {
      tip = lastTipsForTap.find(t => t.landmarkIndex === fingerIndex);
    }

    if (tip && typeof tip.x === 'number' && typeof tip.y === 'number') {
      // Refined tips are already in overlay pixel coordinates
      return { x: tip.x, y: tip.y };
    }
  }

  // 2) Fallback: use raw landmarks (normalized) if no refined tip found
  if (!lastHandsForTap || !lastHandsForTap.length) return null;

  // If specific hand is missing, fall back to the first hand that has this finger index.
  let hand = lastHandsForTap[handIndex];
  if (!hand || hand.length <= fingerIndex) {
    hand = lastHandsForTap.find(h => h && h.length > fingerIndex);
  }
  if (!hand) return null;

  const lm = hand[fingerIndex];
  if (!lm) return null;

  let xNorm = lm.x;
  const yNorm = lm.y;

  if (MIRROR_PREVIEW) {
    xNorm = 1 - xNorm;
  }

  const x = xNorm * overlay.width;
  const y = yNorm * overlay.height;
  return { x, y };
}

// Use existing keyboard mapping to find which key (if any) is under the tap
function mapTapToKey(tapEvent) {
  if (!frozen || !quad) return null;

  const pt = getTapOverlayPoint(tapEvent);
  if (!pt) return null;

  const cells = buildKeyCells(quad);
  const hit = findKeyAtPoint(cells, pt);
  if (!hit) return null;

  return {
    label: hit.label,
    point: pt
  }; 
}

function logTapCandidate(tapEvent) {
  // Compute approximate overlay position for this fingertip on this frame
  const pt     = getTapOverlayPoint(tapEvent);
  const mapped = mapTapToKey(tapEvent);  // may be null if outside keyboard

  const entry = {
    // raw event info from tap.js
    id: tapEvent.id || null,
    handIndex: tapEvent.handIndex,
    fingerIndex: tapEvent.fingerIndex,
    fingerName: tapEvent.fingerName || null,

    timestamp: tapEvent.timestamp,
    totalDurationMs: tapEvent.totalDurationMs,
    dwellFrames: tapEvent.dwellFrames,
    dwellDurationMs: tapEvent.dwellDurationMs,

    startY: tapEvent.startY,
    endY: tapEvent.endY,
    motionLength: tapEvent.motionLength,
    speed: tapEvent.speed,
    avgVelocity: tapEvent.avgVelocity,
    decelMetric: tapEvent.decelMetric,

    score: tapEvent.score,
    passedScoreThreshold: !!tapEvent.passedScoreThreshold,
    scoreThreshold: tapEvent.scoreThreshold ?? null,

    // mapping info
    x: pt ? pt.x : null,
    y: pt ? pt.y : null,
    keyLabel: mapped ? mapped.label : null,

    // label to be filled later (e.g., "real", "glitch", etc.)
    label: null
  };

  tapCandidateLog.push(entry);
  console.log('[Tap candidate]', entry);
}

// Per-frame fingertip motion logging for index fingertips
function logIndexMotionForPlot(result, tips, nowMs) {
  if (!result || !result.landmarks || !result.landmarks.length || !tips || !tips.length) {
    return;
  }

  for (let handIndex = 0; handIndex < result.landmarks.length; handIndex++) {
    const handLms = result.landmarks[handIndex];
    if (!handLms[8]) continue;   // LM 8 is index fingertip

    const lm = handLms[8];
    const refined = tips.find(t => t.handIndex === handIndex && t.finger === "Index");

    // Optional: attach the last tap candidate (for convenience when plotting)
    const lastCand = tapCandidateLog.length
      ? tapCandidateLog[tapCandidateLog.length - 1]
      : null;

    fingertipMotionLog.push({
      t: nowMs,
      handIndex,
      x_raw: lm.x,
      y_raw: lm.y,
      x_refined: refined?.x ?? null,
      y_refined: refined?.y ?? null,
      tapCandidate: lastCand
    });
  }
}

// ---------- Tap UI helpers ----------

function flashTapBorder(tapEvent){
  if (!stageWrap) return;

  // Visual feedback: red border flash
  stageWrap.classList.add('tap-detected-border');
  setTimeout(() => {
    stageWrap.classList.remove('tap-detected-border');
  }, 100);

  // Map tap to key
  const mapped = mapTapToKey(tapEvent);

  if (mapped) {
    const detectionNow = performance.now();

    console.log('[Tap detected → key]', {
      handIndex: tapEvent.handIndex,
      fingerIndex: tapEvent.fingerIndex,
      fingerName: tapEvent.fingerName,
      speed: tapEvent.speed,
      motionLength: tapEvent.motionLength,
      key: mapped.label,
      point: mapped.point
    });

    // If tap typing mode is on, actually type the key
    if (tapTypingModeChk && tapTypingModeChk.checked) {
      const typeStart = performance.now();
      typeKeyLabel(mapped.label, 'tap', {
        x: mapped.point.x,
        y: mapped.point.y,
        handIndex: tapEvent.handIndex,
        finger: tapEvent.fingerName || null
      });
      const typeEnd = performance.now();

      // Log latency for this tap → text path
      tapLatencyLog.push({
        label: mapped.label,
        handIndex: tapEvent.handIndex,
        fingerIndex: tapEvent.fingerIndex,
        fingerName: tapEvent.fingerName || null,

        tapTimestamp: tapEvent.timestamp,         // timestamp from tap.js (ms)
        tapDetectedAt: detectionNow,             // when we mapped tap to a key
        typeCallStartedAt: typeStart,            // before modifying editor
        typedAt: typeEnd,                        // after editor update function returns

        latencyFromDetectionMs: typeEnd - detectionNow,
        latencyFromTapTimestampMs: typeEnd - tapEvent.timestamp
      });
    }
  } else {
    console.log('[Tap detected → no key under tap]', tapEvent);
  }
}

function updateTapLogVisibility() {
  // tapLogPanel may or may not exist in HTML; guard it.
  if (!tapList) return;
  if (showTapLogChk && !showTapLogChk.checked) {
    if (tapList.parentElement) {
      tapList.parentElement.style.display = 'none';
    }
  } else {
    if (tapList.parentElement) {
      tapList.parentElement.style.display = 'block';
    }
  }
}

async function addTapRecord(tapEvent) {
  if (!tapList) return;

  try {
    if (tapList.parentElement) {
      if (!showTapLogChk || showTapLogChk.checked) {
        tapList.parentElement.style.display = 'block';
      }
    }

    const blob = await cam.captureJpeg({ quality: 0.75 });
    if (!blob) return;

    const url = URL.createObjectURL(blob);

    const handLabel = `Hand ${tapEvent.handIndex + 1}`;
    const fingerLabel = tapEvent.fingerName || `LM${tapEvent.fingerIndex}`;
    const speedPerSec = tapEvent.speed * 1000; // y-units per second
    const dist = tapEvent.motionLength;
    const tMs = tapEvent.timestamp.toFixed(1);

    const card = document.createElement('div');
    card.className = 'tap-record';
    card.innerHTML = `
      <img src="${url}" alt="Tap frame">
      <div class="tap-record-info">
        ${handLabel} – ${fingerLabel}<br>
        speed: ${speedPerSec.toFixed(3)} /s<br>
        dist: ${dist.toFixed(4)} y<br>
        t: ${tMs} ms
      </div>
    `;

    if (!tapList.firstElementChild ||
      !tapList.firstElementChild.classList.contains('tap-record')) {
      tapList.innerHTML = '';
    }

    tapList.insertBefore(card, tapList.firstChild);

    const maxCards = 12;
    while (tapList.childElementCount > maxCards) {
      tapList.removeChild(tapList.lastElementChild);
    }
  } catch (e) {
    console.warn('Failed to capture tap frame', e);
  }
}

// ---------- FSM phase logging ----------

function handleTapPhaseChange(ev) {
  // You can filter to index only if you want:
  // if (ev.fingerIndex !== 8) return;
  tapPhaseEvents.push(ev);
}

// ---------- Calibration helpers ----------

function startCalibration() {
  frozen = false;
  calibStartMs = 0;

  // Reset sliding window of F/J samples and frozen averages
  fjSamples = [];
  frozenF = null;
  frozenJ = null;

  quad = null;
  lastFJ = null;
  statusEl.textContent = 'Calibrating… (place index fingertips on F and J)';
}

function recomputeFromAverages() {
  // Use the averaged F/J from the last ~1s of calibration.
  let F = frozenF;
  let J = frozenJ;

  if (!F || !J) {
    if (fjSamples && fjSamples.length) {
      let sumFx = 0, sumFy = 0, sumJx = 0, sumJy = 0;
      const n = fjSamples.length;
      for (const s of fjSamples) {
        sumFx += s.xF; sumFy += s.yF;
        sumJx += s.xJ; sumJy += s.yJ;
      }
      F = { x: sumFx / n, y: sumFy / n };
      J = { x: sumJx / n, y: sumJy / n };
    } else if (lastFJ) {
      F = { x: lastFJ.F.x, y: lastFJ.F.y };
      J = { x: lastFJ.J.x, y: lastFJ.J.y };
    } else {
      return;
    }
  }

  quad = computeQuadFromFJ(F, J);
}

// ---------- Main setup ----------

(async function main() {
  statusEl.textContent = 'Loading model…';
  try {
    await initHands();
    await cam.listCameras();

    // Tap thresholds + localStorage
    let initialSpeed = 0.00015;
    let initialDistance = 0.010;
    let initialScore = 0.20;

    const storedSpeed = localStorage.getItem(SPEED_STORAGE_KEY);
    if (storedSpeed !== null) {
      const v = parseFloat(storedSpeed);
      if (!Number.isNaN(v) && v > 0) initialSpeed = v;
    }

    const storedDist = localStorage.getItem(DISTANCE_STORAGE_KEY);
    if (storedDist !== null) {
      const v = parseFloat(storedDist);
      if (!Number.isNaN(v) && v > 0) initialDistance = v;
    }

    const storedScore = localStorage.getItem(SCORE_STORAGE_KEY);
    if (storedScore !== null) {
      const v = parseFloat(storedScore);
      if (!Number.isNaN(v) && v >= 0 && v <= 1) initialScore = v;
    }

    initTapDetection({
      onTap: (tapEvent) => {
        // taps are only run after frozen in mainLoop
        flashTapBorder(tapEvent);
      },
      onTapCandidate: (tapEvent) => {
        // log ALL candidate taps (including ones below score threshold)
        logTapCandidate(tapEvent);
        // show card in the Tap Events panel
        addTapRecord(tapEvent);
      },
      onPhaseChange: handleTapPhaseChange,
      velocityThreshold: initialSpeed,
      distanceThreshold: initialDistance,
      scoreThreshold: initialScore
    });

    // Make logs accessible from the browser console
    window.tapCandidateLog = tapCandidateLog;
    window.fingertipMotionLog = fingertipMotionLog;
    window.tapPhaseEvents = tapPhaseEvents;
    window.typingLog = typingLog;
    window.tapLatencyLog = tapLatencyLog;

    if (inputSpeedThreshold) {
      inputSpeedThreshold.value = String(initialSpeed);
    }
    if (inputDistanceThreshold) {
      inputDistanceThreshold.value = String(initialDistance);
    }
    if (inputScoreThreshold) {
      inputScoreThreshold.value = String(initialScore.toFixed(6));
    }

    statusEl.textContent = 'Ready. Start camera.';

    // Start / stop camera
    if (btnStartRear) btnStartRear.onclick = () => start(cam.startRear);
    if (btnStartFront) btnStartFront.onclick = () => start(cam.startFront);
    if (cam.camSel) {
      cam.camSel.onchange = () => start(cam.selectDevice, cam.camSel.value);
    }
    if (btnStop) btnStop.onclick = stop;

    // Snapshot
    if (btnSnap) {
      btnSnap.onclick = async () => {
        const blob = await cam.captureJpeg({ quality: 0.9 });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `holokeys_${Date.now()}.jpg`;
        a.click();
        URL.revokeObjectURL(url);
      };
    }

    if (chkBlack && video) {
      chkBlack.onchange = () => {
        video.style.opacity = chkBlack.checked ? '0' : '1';
      };
    }

    if (btnRecal) btnRecal.onclick = startCalibration;

    // Geometry sliders
    if (heightSlider) setHeightScale(heightSlider.value);
    if (ratioSlider) setTopShrink(ratioSlider.value);

    if (heightSlider) {
      heightSlider.addEventListener('input', e => {
        setHeightScale(e.target.value);
        if (frozen) recomputeFromAverages();
      });
    }

    if (ratioSlider) {
      ratioSlider.addEventListener('input', e => {
        setTopShrink(e.target.value);
        if (frozen) recomputeFromAverages();
      });
    }

    if (heightDefaultBtn && heightSlider) {
      heightDefaultBtn.addEventListener('click', () => {
        heightSlider.value = '0.60';
        setHeightScale('0.60');
        if (frozen) recomputeFromAverages();
      });
    }

    if (ratioDefaultBtn && ratioSlider) {
      ratioDefaultBtn.addEventListener('click', () => {
        ratioSlider.value = '0.74';
        setTopShrink('0.74');
        if (frozen) recomputeFromAverages();
      });
    }

    const setupPressureButton = (buttonEl, statusEl, forcedHandIndex) => {
      if (!buttonEl) return;
      setPressureStatus(statusEl, 'Not connected');

      buttonEl.onclick = async () => {
        const isLeft = forcedHandIndex === 0;
        const existingStop = isLeft ? stopPressureLeft : stopPressureRight;

        // Disconnect if already connected
        if (existingStop) {
          try { await existingStop(); } catch (_) {}
          if (isLeft) stopPressureLeft = null; else stopPressureRight = null;
          buttonEl.textContent = isLeft
            ? 'Connect pressure (Left)'
            : 'Connect pressure (Right)';
          setPressureStatus(statusEl, 'Disconnected');
          return;
        }

        try {
          buttonEl.disabled = true;
          setPressureStatus(statusEl, 'Connecting…');
          const stopFn = await connectPressureSensors({
            forcedHandIndex,
            onTap: handlePressureTap,
            onState: (evt) => {
              if (evt?.fingerName && evt.state) {
                setPressureStatus(statusEl, `${evt.fingerName}: ${evt.state}`);
              }
            }
          });
          if (isLeft) stopPressureLeft = stopFn; else stopPressureRight = stopFn;
          buttonEl.textContent = 'Disconnect';
          setPressureStatus(statusEl, 'Connected');
        } catch (err) {
          console.error(err);
          setPressureStatus(statusEl, err?.message || 'Failed to connect');
        } finally {
          buttonEl.disabled = false;
        }
      };
    };

    setupPressureButton(btnConnectPressureLeft, pressureStatusLeft, 0);
    setupPressureButton(btnConnectPressureRight, pressureStatusRight, 1);

    // Tap threshold UI listeners
    if (inputSpeedThreshold) {
      inputSpeedThreshold.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (Number.isNaN(v) || v <= 0) return;
        setTapThresholds({ velocityThreshold: v });
        localStorage.setItem(SPEED_STORAGE_KEY, String(v));
      });
    }

    if (inputDistanceThreshold) {
      inputDistanceThreshold.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (Number.isNaN(v) || v <= 0) return;
        setTapThresholds({ distanceThreshold: v });
        localStorage.setItem(DISTANCE_STORAGE_KEY, String(v));
      });
    }

    if (inputScoreThreshold) {
      inputScoreThreshold.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (Number.isNaN(v) || v < 0 || v > 1) return;
        setTapThresholds({ scoreThreshold: v });
        localStorage.setItem(SCORE_STORAGE_KEY, String(v));
      });
    }

    // ONE BUTTON to export all logs: tap candidates, motion, FSM states, typing, latency
    if (btnExportTapLog) {
      btnExportTapLog.onclick = () => {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        let url, a;

        // 0) Typing log as CSV (for reference / debugging)
        if (typingLog.length) {
          const headers = [
            "timeMs","timeAbsMs","label","source",
            "x","y","handIndex","finger"
          ];
          const rows = typingLog.map(e => [
            e.timeMs,
            e.timeAbsMs,
            JSON.stringify(e.label),
            e.source,
            e.x ?? "",
            e.y ?? "",
            e.handIndex ?? "",
            e.finger ?? ""
          ].join(","));
          const csv = [headers.join(","), ...rows].join("\n");
          const csvBlob = new Blob([csv], { type: "text/csv" });
          url = URL.createObjectURL(csvBlob);
          a = document.createElement("a");
          a.href = url;
          a.download = `typing_log_${ts}.csv`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }

        // 1) Tap candidates as JSON
        const tapJson = JSON.stringify(tapCandidateLog, null, 2);
        const tapBlob = new Blob([tapJson], { type: 'application/json' });
        url = URL.createObjectURL(tapBlob);
        a = document.createElement('a');
        a.href = url;
        a.download = `tap_candidates_${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // 2) Fingertip motion as CSV
        if (fingertipMotionLog.length) {
          const headers = [
            "t","handIndex",
            "x_raw","y_raw",
            "x_refined","y_refined",
            "tapScore","tapSpeed","tapDist","tapLabel"
          ];

          const rows = fingertipMotionLog.map(s => {
            const cand = s.tapCandidate;
            return [
              s.t,
              s.handIndex,
              s.x_raw,
              s.y_raw,
              s.x_refined,
              s.y_refined,
              cand?.score ?? "",
              cand?.speed ?? "",
              cand?.motionLength ?? "",
              cand?.label ?? ""
            ].join(",");
          });

          const csv = [headers.join(","), ...rows].join("\n");
          const csvBlob = new Blob([csv], { type: "text/csv" });
          url = URL.createObjectURL(csvBlob);
          a = document.createElement("a");
          a.href = url;
          a.download = `fingertip_motion_${ts}.csv`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          alert("No motion log data recorded yet.");
        }

        // 3) FSM phase events as JSON
        const phaseJson = JSON.stringify(tapPhaseEvents, null, 2);
        const phaseBlob = new Blob([phaseJson], { type: 'application/json' });
        url = URL.createObjectURL(phaseBlob);
        a = document.createElement('a');
        a.href = url;
        a.download = `tap_fsm_states_${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // 4) Tap latency as CSV (main latency test artifact)
        if (tapLatencyLog.length) {
          const headers = [
            "label",
            "handIndex","fingerIndex","fingerName",
            "tapTimestamp","tapDetectedAt","typeCallStartedAt","typedAt",
            "latencyFromDetectionMs","latencyFromTapTimestampMs"
          ];
          const rows = tapLatencyLog.map(e => [
            JSON.stringify(e.label),
            e.handIndex ?? "",
            e.fingerIndex ?? "",
            JSON.stringify(e.fingerName ?? ""),
            e.tapTimestamp,
            e.tapDetectedAt,
            e.typeCallStartedAt,
            e.typedAt,
            e.latencyFromDetectionMs,
            e.latencyFromTapTimestampMs
          ].join(","));
          const csv = [headers.join(","), ...rows].join("\n");
          const csvBlob = new Blob([csv], { type: "text/csv" });
          url = URL.createObjectURL(csvBlob);
          a = document.createElement("a");
          a.href = url;
          a.download = `tap_latency_${ts}.csv`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      };
    }

    // Tap log visibility toggle
    if (showTapLogChk) {
      showTapLogChk.addEventListener('change', updateTapLogVisibility);
      updateTapLogVisibility();
    }

    // Editor helpers
    if (focusEditorBtn) focusEditorBtn.onclick = () => editor?.focus();
    if (clearEditorBtn) clearEditorBtn.onclick = () => setValueAndCaret('', 0);
  } catch (e) {
    console.error(e);
    statusEl.textContent = `Error: ${e.message}`;
  }
})();

// ---------- Camera start/stop ----------

async function start(startFn, ...args) {
  if (btnStartRear) btnStartRear.disabled = true;
  if (btnStartFront) btnStartFront.disabled = true;
  if (btnStop) btnStop.disabled = true;
  statusEl.textContent = 'Starting camera…';
  try {
    await startFn(...args);
    statusEl.textContent = 'Camera running.';
    if (btnStop) btnStop.disabled = false;
    if (video) {
      video.style.opacity = '1';
    }
    if (chkBlack) chkBlack.checked = false;
    cam.onVideoFrame(mainLoop);
    startCalibration();
  } catch (e) {
    console.error(e);
    statusEl.textContent = `Error starting camera: ${e.message}`;
  } finally {
    if (btnStartRear) btnStartRear.disabled = false;
    if (btnStartFront) btnStartFront.disabled = false;
  }
}

function stop() {
  cam.stopStream();
  clearOverlay();
  statusEl.textContent = 'Stopped.';
  if (btnStop) btnStop.disabled = true;
}

// ---------- Main loop ----------

function mainLoop() {
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) return;

  if (W !== lastW || H !== lastH) {
    lastW = W; lastH = H;
    resizeOverlayToVideo(W, H);
  }

  const result = detect();
  const nowMs = performance.now();

  // Save landmarks for tap→key mapping
  lastHandsForTap = (result && result.landmarks) ? result.landmarks : [];

  // Vision-based tap detection: only when calibration is finished and
  // pressure sensors are not connected (to avoid double-typing).
  const pressureActive = !!(stopPressureLeft || stopPressureRight);
  if (!pressureActive && frozen && result && result.landmarks && result.landmarks.length) {
    const hands = result.landmarks;
    const numHands = Math.min(hands.length, 2);

    for (let handIndex = 0; handIndex < numHands; handIndex++) {
      const landmarks = hands[handIndex];
      updateTapFromLandmarks(landmarks, handIndex, nowMs);
    }

    runTapDetectionFrame(nowMs);
  }

  clearOverlay();
  drawHands(result, W, H); // respects Show landmarks

  const tips = result ? refineFingertips(result, W, H, MIRROR_PREVIEW) : [];
  lastTipsForTap = tips;

  // Per-frame motion logging for Index fingertips (for plotting)
  logIndexMotionForPlot(result, tips, nowMs);

  drawFingertipMarkers(tips);
  updateTipLog(result, tips);

  // During calibration: follow fingertips and maintain sliding 1s window of F/J
  if (!frozen && tips && tips.length) {
    const idx = tips.filter(t => t.finger === 'Index').sort((a, b) => a.x - b.x);
    if (idx.length >= 2) {
      const F = idx[0], J = idx[idx.length - 1];
      lastFJ = { F: { x: F.x, y: F.y }, J: { x: J.x, y: J.y } };

      quad = computeQuadFromFJ({ x: F.x, y: F.y }, { x: J.x, y: J.y });

      // start timer on first valid quad
      const now = performance.now();
      if (!calibStartMs) calibStartMs = now;

      // Maintain a sliding window (~last 1s) of F/J positions for freeze.
      fjSamples.push({ xF: F.x, yF: F.y, xJ: J.x, yJ: J.y, t: now });
      const cutoff = now - 1000;
      fjSamples = fjSamples.filter(s => s.t >= cutoff);

      const elapsed = (now - calibStartMs) / 1000;
      if (elapsed >= 10) {
        frozen = true;

        // At freeze, compute average F/J from the last ~1s of samples.
        if (fjSamples.length) {
          let sumFx = 0, sumFy = 0, sumJx = 0, sumJy = 0;
          const n = fjSamples.length;
          for (const s of fjSamples) {
            sumFx += s.xF; sumFy += s.yF;
            sumJx += s.xJ; sumJy += s.yJ;
          }
          frozenF = { x: sumFx / n, y: sumFy / n };
          frozenJ = { x: sumJx / n, y: sumJy / n };
        } else if (lastFJ) {
          frozenF = { x: lastFJ.F.x, y: lastFJ.F.y };
          frozenJ = { x: lastFJ.J.x, y: lastFJ.J.y };
        } else {
          frozenF = null;
          frozenJ = null;
        }

        // Lock keyboard geometry based on averaged last-1s F/J
        recomputeFromAverages();
        statusEl.textContent = 'Frozen';

        // Start typing session timer
        typingSessionStartMs = now;
      } else {
        statusEl.textContent = `Calibrating… ${(10 - elapsed).toFixed(1)}s`;
      }

    }
  }

  // Draw full keyboard & finger→key tooltips
  drawKeyboard(quad);
  drawKeycaps(quad);
  drawTapKeyHighlight(quad);
  drawFingerKeyLabels(tips, quad);

  // F/J debug crosses
  if (showDebugChk?.checked) {
    const drawX = (pt, r = 6) => {
      octx.beginPath();
      octx.moveTo(pt.x - r, pt.y - r); octx.lineTo(pt.x + r, pt.y + r);
      octx.moveTo(pt.x + r, pt.y - r); octx.lineTo(pt.x - r, pt.y + r);
      octx.stroke();
    };
    octx.save();
    octx.strokeStyle = 'rgba(0,255,255,0.95)';
    octx.lineWidth = 2;
    if (frozen && frozenF && frozenJ) {
      drawX(frozenF); drawX(frozenJ);
    } else if (lastFJ) {
      drawX(lastFJ.F); drawX(lastFJ.J);
    }
  }

  // Typing only after freeze.
  // When tap typing mode is enabled, we disable hover typing to avoid double entries.
  if (frozen && tips && tips.length &&
    !(tapTypingModeChk && tapTypingModeChk.checked)) {
    doTyping(tips, quad);
  }
}
