// tap.js
// Dwell-based tap detection using vertical fingertip motion over time.
// Only vertical axis (y) is used for classification. Horizontal is handled
// later in app.js for key mapping.

// ---------- Constants ----------

// Fingertip landmark indices in MediaPipe Hands
const TAP_FINGERTIP_INDICES = [4, 8, 12, 16, 20];
const TAP_FINGERTIP_NAMES = {
  4:  'Thumb',
  8:  'Index',
  12: 'Middle',
  16: 'Ring',
  20: 'Pinky'
};

// If both fire at same time on the same hand, dominant suppresses submissive.
const FINGER_SUPPRESSION_HIERARCHY = {
  // ring (16) suppresses pinky (20)
  16: 20
};

// History / timing constants
const TAP_HISTORY_LENGTH       = 15;      // samples stored per fingertip
const TAP_DEBOUNCE_DELAY       = 500;     // ms between taps (global)
const TAP_MAX_WINDOW_MS        = 350;     // max duration from start→dwell

// Dwell / “stop” thresholds (hard gates, not part of score)
const STOP_VEL_THRESHOLD       = 0.0004;  // y-units/ms, considered stopped
const DWELL_VEL_THRESHOLD      = 0.0003;  // allowed jitter while dwelling
const DWELL_Y_RADIUS           = 0.004;   // max y deviation during dwell
const DWELL_MIN_FRAMES         = 3;       // require this many dwell frames
const DWELL_MIN_DURATION_MS    = 40;      // or this many ms of dwell
const MIN_DECEL_METRIC         = 0.2;     // require some deceleration

// Score threshold: only taps with score ≥ this are accepted as "real taps"
const TAP_SCORE_THRESHOLD      = 0.2;

// Tunable thresholds (overridden by initTapDetection / setTapThresholds)
// These connect to your UI controls in app.js.
let tapVelocityThreshold = 0.00015;  // y-units/ms to start a tap
let minTapDistance       = 0.010;    // y-units total downward travel

// ---------- Internal state ----------

// Per-hand (0/1), per fingertip index history & state
let tapHistory = {
  0: {},
  1: {}
};

let tapStates = {
  0: {},
  1: {}
};

// last successful tap time for global debounce
let lastTapTime = 0;

// Optional callbacks into app.js
let onTapCallback = null;
let onTapCandidateCallback = null;

// ---------- Utility helpers ----------

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function resetFingerState(state) {
  state.phase          = 'idle';
  state.startY         = 0;
  state.startTimestamp = 0;
  state.peakVelocity   = 0;
  state.maxDistance    = 0;
  state.dwellStartY    = 0;
  state.dwellStartTime = 0;
  state.dwellFrames    = 0;
  state.lastVelocity   = 0;
}

/**
 * Initialize tap history & state for all hands/fingers.
 */
function initTapState(){
  tapHistory = { 0: {}, 1: {} };
  tapStates  = { 0: {}, 1: {} };

  for (let handIndex = 0; handIndex < 2; handIndex++) {
    TAP_FINGERTIP_INDICES.forEach(fingerIndex => {
      tapHistory[handIndex][fingerIndex] = [];
      const st = {};
      resetFingerState(st);
      tapStates[handIndex][fingerIndex] = st;
    });
  }

  lastTapTime = 0;
}

/**
 * Record motion for one hand's landmarks at a given time.
 * Uses normalized landmark.y (0..1) and stores a small history.
 */
function recordHandMotion(landmarks, handIndex, timestampMs){
  if (!landmarks || handIndex == null) return;

  const historiesForHand = tapHistory[handIndex];
  if (!historiesForHand) return;

  TAP_FINGERTIP_INDICES.forEach(index => {
    if (landmarks.length > index) {
      const fingerTip = landmarks[index];
      let history = historiesForHand[index];
      if (!history) {
        history = [];
        historiesForHand[index] = history;
      }

      history.push({
        y:    fingerTip.y,
        time: timestampMs
      });

      if (history.length > TAP_HISTORY_LENGTH) {
        history.shift();
      }
    }
  });
}

/**
 * Compute downward velocity (y-units/ms) from the last two samples.
 */
function computeVelocity(history) {
  if (!history || history.length < 2) return 0;
  const n = history.length;
  const curr = history[n - 1];
  const prev = history[n - 2];
  const dt   = curr.time - prev.time;
  if (dt <= 0) return 0;
  const dy = curr.y - prev.y; // downward = positive
  if (dy <= 0) return 0;      // only care about downward motion
  return dy / dt;
}

/**
 * Coarse deceleration metric using the last 3 samples.
 * Returns 0..1, higher means stronger recent slowing.
 */
function computeDeceleration(history, currentVelocity) {
  if (!history || history.length < 3) return 0;
  const n = history.length;
  const curr = history[n - 1];
  const mid  = history[n - 2];
  const prev = history[n - 3];

  const dt1 = mid.time - prev.time;
  const dt2 = curr.time - mid.time;
  if (dt1 <= 0 || dt2 <= 0) return 0;

  const vPrev = Math.max(0, (mid.y - prev.y) / dt1);
  const vNow  = currentVelocity;

  if (vPrev <= 0) return 0;
  const dv = vPrev - vNow;
  if (dv <= 0) return 0;

  return clamp(dv / vPrev, 0, 1);
}

/**
 * Compute tap score in [0,1] using ONLY:
 *  - peakVelocity
 *  - avgVelocity
 *  - totalDistance
 */
function computeTapScore(peakVelocity, avgVelocity, totalDistance) {
  // Normalize peak velocity: prefer values above tapVelocityThreshold
  const velNorm = clamp(
    (peakVelocity - tapVelocityThreshold) / (tapVelocityThreshold * 3),
    0,
    1
  );

  // Normalize average velocity: want somewhat above half the threshold
  const baseAvg = tapVelocityThreshold * 0.5;
  const avgNorm = clamp(
    (avgVelocity - baseAvg) / (tapVelocityThreshold * 3),
    0,
    1
  );

  // Normalize distance: prefer distance above minTapDistance.
  const distNorm = clamp(
    (totalDistance - minTapDistance) / (minTapDistance * 3),
    0,
    1
  );

  const score =
    0.4 * velNorm +
    0.3 * avgNorm +
    0.3 * distNorm;

  return clamp(score, 0, 1);
}

/**
 * State machine per fingertip. Examine latest history and update the FSM.
 * If a tap is detected on this frame, returns a tap event; otherwise null.
 */
function updateFingerStateForTap(
  handIndex,
  fingerIndex,
  history,
  state
) {
  if (!history || history.length < 2) return null;

  const n     = history.length;
  const curr  = history[n - 1];
  const currY = curr.y;
  const currT = curr.time;

  const v = computeVelocity(history);
  const decelMetric = computeDeceleration(history, v);

  if (!state.phase) {
    resetFingerState(state);
  }

  switch (state.phase) {
    case 'idle': {
      // Look for a clear downward movement start.
      if (v > tapVelocityThreshold) {
        state.phase          = 'moving';
        state.startY         = history[n - 2]?.y ?? currY;
        state.startTimestamp = currT;
        state.peakVelocity   = v;
        state.maxDistance    = 0;
        state.dwellStartY    = 0;
        state.dwellStartTime = 0;
        state.dwellFrames    = 0;
        state.lastVelocity   = v;
      }
      break;
    }

    case 'moving': {
      const distance = currY - state.startY;
      if (distance > state.maxDistance) {
        state.maxDistance = distance;
      }

      if (v > state.peakVelocity) {
        state.peakVelocity = v;
      }

      const elapsed = currT - state.startTimestamp;

      // If motion reverses or takes too long, abandon.
      if (distance < 0 || elapsed > TAP_MAX_WINDOW_MS) {
        resetFingerState(state);
        break;
      }

      // Check if we should transition to dwell:
      //  - enough downward travel
      //  - velocity now small (almost stopped)
      if (
        distance > minTapDistance &&
        v < STOP_VEL_THRESHOLD &&
        v >= 0
      ) {
        state.phase          = 'dwell';
        state.dwellStartY    = currY;
        state.dwellStartTime = currT;
        state.dwellFrames    = 1;
      }

      state.lastVelocity = v;
      break;
    }

    case 'dwell': {
      const dwellDy      = Math.abs(currY - state.dwellStartY);
      const isVelSmall   = v < DWELL_VEL_THRESHOLD;
      const isWithinY    = dwellDy <= DWELL_Y_RADIUS;
      const dwellElapsed = currT - state.dwellStartTime;

      if (isVelSmall && isWithinY) {
        state.dwellFrames += 1;
      } else {
        // Dwell broken ⇒ not a tap.
        resetFingerState(state);
        break;
      }

      // Hard threshold #1: sufficient dwell frames & time
      if (
        state.dwellFrames < DWELL_MIN_FRAMES &&
        dwellElapsed < DWELL_MIN_DURATION_MS
      ) {
        break; // keep dwelling
      }

      // Hard threshold #2: deceleration should be non-trivial
      if (decelMetric < MIN_DECEL_METRIC) {
        resetFingerState(state);
        break;
      }

      // Hard threshold #3: overall gesture duration shouldn't be huge
      const totalDurationMs = currT - state.startTimestamp;
      if (totalDurationMs <= 0 || totalDurationMs > TAP_MAX_WINDOW_MS) {
        resetFingerState(state);
        break;
      }

      // At this point, we have a "candidate tap" gesture:
      //  - rapid downward movement
      //  - sufficient distance
      //  - clear stop & short dwell
      // Compute the tap score based ONLY on peakVelocity, avgVelocity, totalDistance.
      const totalDistance = state.maxDistance;
      const avgVelocity   = totalDistance / totalDurationMs;

      const score = computeTapScore(
        state.peakVelocity,
        avgVelocity,
        totalDistance
      );

      // Build candidate event with score and dwell info
      const candidate = {
        handIndex,
        fingerIndex,
        timestamp: currT,
        speed: state.peakVelocity,
        motionLength: totalDistance,
        dwellFrames: state.dwellFrames,
        dwellDurationMs: dwellElapsed,
        score,
        fingerName: TAP_FINGERTIP_NAMES[fingerIndex] || `LM${fingerIndex}`,
        // NEW: start/end vertical positions (normalized 0..1, downward = larger)
        startY: state.startY,
        finalY: currY
      };      

      // Report ALL candidates to debug callback (for logging/tuning)
      if (onTapCandidateCallback) {
        onTapCandidateCallback(candidate);
      }

      // Only treat as a real tap if the score passes threshold
      if (score >= TAP_SCORE_THRESHOLD) {
        resetFingerState(state);
        return candidate;
      }

      // Score too low ⇒ treat as non-tap
      resetFingerState(state);
      break;
    }

    default: {
      resetFingerState(state);
      break;
    }
  }

  return null;
}

/**
 * Core tap detection: update FSMs for all fingertips & gather taps.
 */
function checkForTap(){
  const potentialTapEvents = [];

  for (let handIndex = 0; handIndex < 2; handIndex++) {
    const handTipHistories = tapHistory[handIndex];
    const handStates       = tapStates[handIndex];
    if (!handTipHistories || !handStates) continue;

    for (const fingerIndex of TAP_FINGERTIP_INDICES) {
      const history = handTipHistories[fingerIndex];
      const state   = handStates[fingerIndex];
      if (!history || !state) continue;
      if (history.length < 2) continue;

      const tapEvent = updateFingerStateForTap(
        handIndex,
        fingerIndex,
        history,
        state
      );

      if (tapEvent) {
        potentialTapEvents.push(tapEvent);
      }
    }
  }

  return potentialTapEvents;
}

/**
 * Apply suppression (e.g., ring > pinky) and global debounce,
 * then call onTap for final taps.
 */
 function processTapEvents(potentialTaps){
  if (!potentialTaps || potentialTaps.length === 0) return [];

  // Global debounce: if too soon since last tap, drop all.
  const nowAny = potentialTaps[0].timestamp;
  if (nowAny - lastTapTime <= TAP_DEBOUNCE_DELAY) {
    return [];
  }

  // First, collapse by (handIndex, fingerIndex) so we only keep the
  // latest candidate per finger in this frame batch.
  const tapsByKey = potentialTaps.reduce((acc, tap) => {
    const key = `${tap.handIndex}-${tap.fingerIndex}`;
    acc[key] = tap;
    return acc;
  }, {});

  // Apply finger suppression on each hand (e.g., Ring > Pinky).
  for (const [dominantIndexStr, submissiveIndex] of Object.entries(FINGER_SUPPRESSION_HIERARCHY)) {
    const dominantIndex = parseInt(dominantIndexStr, 10);

    for (let handIndex = 0; handIndex < 2; handIndex++) {
      const dominantKey   = `${handIndex}-${dominantIndex}`;
      const submissiveKey = `${handIndex}-${submissiveIndex}`;

      if (tapsByKey[dominantKey] && tapsByKey[submissiveKey]) {
        delete tapsByKey[submissiveKey];
      }
    }
  }

  // NEW: per-hand "lowest finger wins" filter.
  // Group surviving taps by handIndex, then keep only the tap whose
  // finalY is largest (i.e., physically lowest on the image).
  const tapsPerHand = {};
  Object.values(tapsByKey).forEach(tap => {
    const h = tap.handIndex ?? 0;
    if (!tapsPerHand[h]) {
      tapsPerHand[h] = [];
    }
    tapsPerHand[h].push(tap);
  });

  const finalTaps = [];

  const metricForTap = (tap) => {
    if (typeof tap.finalY === 'number') {
      return tap.finalY;
    }
    // Fallback if finalY somehow missing: use startY + motionLength, or just motionLength
    if (typeof tap.startY === 'number' && typeof tap.motionLength === 'number') {
      return tap.startY + tap.motionLength;
    }
    return typeof tap.motionLength === 'number' ? tap.motionLength : -Infinity;
  };

  for (const handKey of Object.keys(tapsPerHand)) {
    const taps = tapsPerHand[handKey];
    if (!taps.length) continue;

    if (taps.length === 1) {
      finalTaps.push(taps[0]);
      continue;
    }

    let best = taps[0];
    let bestMetric = metricForTap(best);

    for (let i = 1; i < taps.length; i++) {
      const candidate = taps[i];
      const m = metricForTap(candidate);
      if (m > bestMetric) {
        best = candidate;
        bestMetric = m;
      }
    }

    finalTaps.push(best);
  }

  // Call back into app.js for each final tap
  if (onTapCallback) {
    finalTaps.forEach(tap => onTapCallback(tap));
  }

  if (finalTaps.length > 0) {
    lastTapTime = finalTaps[0].timestamp;
  }

  return finalTaps;
}


// ---------- Public API ----------

/**
 * Initialize tap detection.
 * options: {
 *   onTap?: (tapEvent) => void,
 *   onTapCandidate?: (tapEvent) => void,   // NEW: all candidate taps w/ score
 *   velocityThreshold?: number,
 *   distanceThreshold?: number
 * }
 */
export function initTapDetection(options = {}){
  const {
    onTap,
    onTapCandidate,
    velocityThreshold,
    distanceThreshold
  } = options;

  onTapCallback = (typeof onTap === 'function') ? onTap : null;
  onTapCandidateCallback =
    (typeof onTapCandidate === 'function') ? onTapCandidate : null;

  if (typeof velocityThreshold === 'number') {
    tapVelocityThreshold = velocityThreshold;
  }
  if (typeof distanceThreshold === 'number') {
    minTapDistance = distanceThreshold;
  }

  initTapState();
}

/**
 * Dynamically update thresholds from UI controls.
 */
export function setTapThresholds({ velocityThreshold, distanceThreshold } = {}){
  if (typeof velocityThreshold === 'number') {
    tapVelocityThreshold = velocityThreshold;
  }
  if (typeof distanceThreshold === 'number') {
    minTapDistance = distanceThreshold;
  }
}

/**
 * Feed raw landmarks for ONE hand into the tap history.
 * Call this once per frame per hand (0/1).
 */
export function updateTapFromLandmarks(landmarks, handIndex, timestampMs){
  recordHandMotion(landmarks, handIndex, timestampMs);
}

/**
 * Run the tap detection state machine for this frame.
 * Returns an array of tap events that occurred at this timestamp.
 */
export function runTapDetectionFrame(timestampMs){
  const potentialTaps = checkForTap();
  const finalTaps = processTapEvents(potentialTaps);
  return finalTaps;
}