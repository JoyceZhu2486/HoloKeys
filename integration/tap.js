// tap.js
// Tap detection using a lift → tap-descent → dwell FSM.
// Main evidence comes from downward motion + short dwell,
// with lift as a weaker supporting cue.
//
// Public API (used by app.js):
//   initTapDetection(options)
//   setTapThresholds({ velocityThreshold, distanceThreshold, scoreThreshold })
//   updateTapFromLandmarks(landmarks, handIndex, timestampMs)
//   runTapDetectionFrame(timestampMs)
//
// Coordinate system:
//   MediaPipe landmark.y is in [0,1], with 0 at top, 1 at bottom.
//   Downward motion ⇒ increasing y, upward motion ⇒ decreasing y.

//////////////////////
// Global constants //
//////////////////////

// Fingertip landmark indices in MediaPipe Hands
const TAP_FINGERTIP_INDICES = [4, 8, 12, 16, 20];
const TAP_FINGERTIP_NAMES = {
  4: "Thumb",
  8: "Index",
  12: "Middle",
  16: "Ring",
  20: "Pinky",
};

// Which finger(s) we care about for keyboard tap detection
const ENABLED_FINGERS = {
  8: true, // Index
  // you could also enable thumb / other fingers if you want:
  // 4: true,
  // 12: true,
};

// Default thresholds (user can override via setTapThresholds)
let tapVelocityThreshold = 0.00015; // "tap start speed" slider
let minTapDistance = 0.010;         // "min tap distance" slider
let tapScoreThreshold = 0.20;       // "tap score threshold" slider

// Derived thresholds (updated whenever sliders change)
let downEnterVel = 0.00020;
let tapDownDistMin = 0.007;
let minDistHard = 0.006;
let minDurHard = 30;
let upExitVel = 0.0004;
let velMinHard = 0.0002;

const MIN_DIST_FACTOR = 0.6; // scales minDistHard from minTapDistance
const MIN_DUR_HARD_BASE = 40;

// Dwell parameters
const DWELL_Y_RADIUS         = 0.004;   // allowed y deviation during dwell
const DWELL_VEL_THRESHOLD    = 0.00008; // "stillness" around bottom
const DWELL_MIN_FRAMES       = 2;
const DWELL_MIN_DURATION_MS  = 50;
const DWELL_MAX_DURATION_MS  = 220;

// Global time window for a tap (lift + descent + dwell)
const TAP_MAX_WINDOW_MS      = 320;

// Upward velocity to skip directly back into lift
const UP_EXIT_VEL_BASE       = 0.00040;

// Hard limits for distance/duration
const MAX_DIST_HARD          = 0.04;   // extremely large downward motion → reject
const MAX_DUR_HARD           = 280;    // extremely long "tap" → reject

// Motion sampling
const HISTORY_WINDOW_MS      = 260;    // only last N ms of samples used for velocity
const MIN_HISTORY_SAMPLES    = 2;      // need at least 2 samples for velocity

// Used to avoid double taps from same finger in a tiny time window
const PER_FINGER_COOLDOWN_MS = 90;

///////////////////////////
///////////////////////////

// We dynamically compute these from user sliders in updateDerivedThresholds().
function updateDerivedThresholds() {
  // How easy it is to start tap descent:
  // slightly above user's "tap start speed" slider, but never absurdly high.
  downEnterVel = Math.max(
    tapVelocityThreshold * 1.8,
    tapVelocityThreshold * 0.8,
    0.000015
  );

  // Minimum downward distance before going into dwell:
  // allow taps slightly smaller than minTapDistance.
  tapDownDistMin = Math.max(0.002, minTapDistance * 0.8);

  // Mild "hard" minimum distance for a tap:
  // pick something that kills 0.004–0.005 I-taps but keeps 0.007–0.01 J-taps.
  minDistHard = Math.max(0.003, minTapDistance * MIN_DIST_FACTOR);

  // Mild minimum duration: scale a bit with minTapDistance (smaller motion may be quicker).
  minDurHard = Math.max(MIN_DUR_HARD_BASE * (minTapDistance / 0.01), 25);

  // Upward exit velocity: also related to tapVelocityThreshold so it scales.
  upExitVel = Math.max(UP_EXIT_VEL_BASE, tapVelocityThreshold * 2.0);

  // Velocity hard gate: real taps have peak speeds an order of magnitude
  // above jitter. Require at least ~8× slider or a small absolute floor.
  velMinHard = Math.max(tapVelocityThreshold * 8.0, 0.00006);
}

//////////////////////////
// Internal data structs //
//////////////////////////

// Per-hand, per-fingertip motion history: { time, y }
let tapHistory = { 0: {}, 1: {} };

// Per-hand, per-fingertip FSM state
let tapStates = { 0: {}, 1: {} };

// Optional callbacks into app.js
let onTapCallback = null;
let onTapCandidateCallback = null;
let onPhaseChangeCallback = null;  // FSM state change callback

//////////////////////
// Helper functions //
//////////////////////

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function resetFingerState(state) {
  const baselineY =
    state && typeof state.baselineY === "number" ? state.baselineY : null;

  state.phase = "idle"; // "idle" | "lift" | "tapDescent" | "tapDwell"

  // Lift
  state.liftStartY = 0;
  state.liftStartTime = 0;
  state.liftMaxY = 0;
  state.liftDistance = 0;
  state.liftDurationMs = 0;
  state.downFramesInLift = 0;

  // Tap descent
  state.tapStartY = 0;
  state.tapStartTime = 0;
  state.tapMaxDownDist = 0;
  state.tapPeakDownVel = 0;

  // Dwell
  state.dwellStartY = 0;
  state.dwellStartTime = 0;
  state.dwellFramesStable = 0;

  // Baseline
  state.baselineY = baselineY != null ? baselineY : null;
}

function ensureFingerState(handIndex, lmIndex) {
  if (!tapStates[handIndex]) {
    tapStates[handIndex] = {};
  }
  if (!tapStates[handIndex][lmIndex]) {
    tapStates[handIndex][lmIndex] = {
      phase: "idle",
      baselineY: null,
      liftStartY: 0,
      liftStartTime: 0,
      liftMaxY: 0,
      liftDistance: 0,
      liftDurationMs: 0,
      downFramesInLift: 0,
      tapStartY: 0,
      tapStartTime: 0,
      tapMaxDownDist: 0,
      tapPeakDownVel: 0,
      dwellStartY: 0,
      dwellStartTime: 0,
      dwellFramesStable: 0,
    };
  }
  return tapStates[handIndex][lmIndex];
}

function ensureHistory(handIndex, lmIndex) {
  if (!tapHistory[handIndex]) {
    tapHistory[handIndex] = {};
  }
  if (!tapHistory[handIndex][lmIndex]) {
    tapHistory[handIndex][lmIndex] = [];
  }
  return tapHistory[handIndex][lmIndex];
}

// Per-finger cooldown tracking
let lastTapTime = {
  0: {}, // per handIndex
  1: {},
};

function canFireTap(handIndex, fingerIndex, t) {
  const now = t;
  const prev = lastTapTime[handIndex][fingerIndex] ?? -Infinity;
  if (now - prev < PER_FINGER_COOLDOWN_MS) {
    return false;
  }
  lastTapTime[handIndex][fingerIndex] = now;
  return true;
}

// Finite difference velocity: positive = downward
function computeSignedVelocity(history) {
  const n = history.length;
  if (n < 2) return 0;

  const latest = history[n - 1];
  let oldest = history[0];

  for (let i = n - 2; i >= 0; i--) {
    const cand = history[i];
    if (latest.time - cand.time > HISTORY_WINDOW_MS) break;
    oldest = cand;
  }

  const dt = latest.time - oldest.time;
  if (dt <= 0) return 0;

  const dy = latest.y - oldest.y;
  return dy / dt;
}

//////////////////////////
// Confidence scoring   //
//////////////////////////

function computeTapConfidence(params) {
  const {
    liftDistance,
    liftDurationMs,
    tapMaxDownDist,
    tapPeakDownVel,
    tapDurationMs,
    dwellFramesStable,
    dwellDurationMs,
  } = params;

  const minD = minTapDistance;
  const sliderV = tapVelocityThreshold;

  let score = 0;
  let weightSum = 0;

  const addTerm = (value, weight) => {
    score += value * weight;
    weightSum += weight;
  };

  // --- Lift (small weight) ---
  const liftTargetDist = Math.max(0.5 * minTapDistance, 0.003);
  const liftDistNorm = clamp(
    (liftDistance - liftTargetDist / 2) /
      (liftTargetDist - liftTargetDist / 2 + 1e-6),
    0,
    1
  );

  const liftDurTarget = 65;
  const liftDurNorm = clamp(
    1 - Math.abs(liftDurationMs - liftDurTarget) / (liftDurTarget + 40),
    0,
    1
  );

  addTerm(0.4 * liftDistNorm + 0.6 * liftDurNorm, 0.15);

  // --- Downward leg (main) ---
  // Distance term: 0 until we pass a distFloor (~0.006–0.007), then up to 1.
  const distFloor = Math.max(minTapDistance * 0.6, 0.003);
  const distCeil = Math.max(minTapDistance * 4.0, distFloor + 0.02);

  const distNorm = clamp(
    (tapMaxDownDist - distFloor) / (distCeil - distFloor + 1e-6),
    0,
    1
  );

  const velFloor = sliderV * 4.0;
  const velCeil = sliderV * 18.0;
  const velNorm = clamp(
    (tapPeakDownVel - velFloor) / (velCeil - velFloor + 1e-6),
    0,
    1
  );

  const durTarget = 120;
  const durNorm = clamp(
    1 - Math.abs(tapDurationMs - durTarget) / (durTarget + 80),
    0,
    1
  );

  addTerm(0.6 * distNorm + 0.5 * velNorm + 0.3 * durNorm, 0.55);

  // --- Dwell (medium weight) ---
  const dwellFramesTarget = 3;
  const dwellFramesNorm = clamp(
    dwellFramesStable / dwellFramesTarget,
    0,
    1.2
  );

  const dwellTarget = 120;
  const dwellNorm = clamp(
    1 - Math.abs(dwellDurationMs - dwellTarget) / (dwellTarget + 80),
    0,
    1
  );

  addTerm(0.5 * dwellFramesNorm + 0.5 * dwellNorm, 0.30);

  if (weightSum <= 0) return 0;
  let finalScore = score / weightSum;

  const distPenalty =
    tapMaxDownDist > MAX_DIST_HARD ? 0.2 : tapMaxDownDist > minD * 3.0 ? 0.9 : 1.0;
  finalScore *= distPenalty;

  return clamp(finalScore, 0, 1);
}

/////////////////////////////
// Core FSM update per tip //
/////////////////////////////

function updateFingerStateForTap(handIndex, fingerIndex, history, state) {
  if (!history || history.length < 2) return null;

  const n = history.length;
  const curr = history[n - 1];
  const currY = curr.y;
  const currT = curr.time;

  const prevPhase = state.phase || "idle";
  let tapEvent = null;

  const vSigned = computeSignedVelocity(history);
  const vDown = vSigned > 0 ? vSigned : 0;
  const vUp = vSigned < 0 ? -vSigned : 0;

  if (state.baselineY == null || Number.isNaN(state.baselineY)) {
    state.baselineY = currY;
  }

  const absVel = Math.abs(vSigned);
  if (state.phase === "idle" && absVel < 0.0001) {
    state.baselineY = state.baselineY * 0.9 + currY * 0.1;
  }

  const baselineY = state.baselineY;
  const liftFromBaseline = baselineY - currY;

  switch (state.phase) {
    case "idle": {
      if (
        liftFromBaseline > 0.002 ||
        vUp > tapVelocityThreshold * 0.6
      ) {
        state.phase = "lift";
        state.liftStartY = currY;
        state.liftStartTime = currT;
        state.liftMaxY = currY;
        state.liftDistance = 0;
        state.liftDurationMs = 0;
        state.downFramesInLift = 0;
      }
      break;
    }

    case "lift": {
      if (currY < state.liftMaxY) state.liftMaxY = currY;
      state.liftDistance = baselineY - state.liftMaxY;
      state.liftDurationMs = currT - state.liftStartTime;

      if (state.liftDurationMs > 220) {
        resetFingerState(state);
        break;
      }

      if (vDown > downEnterVel) {
        state.downFramesInLift += 1;
      } else {
        state.downFramesInLift = 0;
      }

      if (state.downFramesInLift >= 2) {
        state.phase = "tapDescent";
        state.tapStartY = currY;
        state.tapStartTime = currT;
        state.tapMaxDownDist = 0;
        state.tapPeakDownVel = vDown;
      }
      break;
    }

    case "tapDescent": {
      const downDist = currY - state.tapStartY;
      const elapsedMs = currT - state.tapStartTime;

      if (downDist > state.tapMaxDownDist) state.tapMaxDownDist = downDist;
      if (vDown > state.tapPeakDownVel) state.tapPeakDownVel = vDown;

      if (downDist < -0.006 || elapsedMs > TAP_MAX_WINDOW_MS) {
        resetFingerState(state);
        break;
      }

      if (
        state.tapMaxDownDist > tapDownDistMin &&
        vDown < DWELL_VEL_THRESHOLD
      ) {
        state.phase = "tapDwell";
        state.dwellStartY = currY;
        state.dwellStartTime = currT;
        state.dwellFramesStable = 0;
      }
      break;
    }

    case "tapDwell": {
      const dy = Math.abs(currY - state.dwellStartY);
      const isStill =
        Math.abs(vSigned) < DWELL_VEL_THRESHOLD && dy <= DWELL_Y_RADIUS;
      const dwellElapsed = currT - state.dwellStartTime;

      if (isStill) state.dwellFramesStable += 1;

      if (!isStill && dy > DWELL_Y_RADIUS * 2) {
        resetFingerState(state);
        break;
      }

      const tapDurationMs = currT - state.tapStartTime;
      const dwellFramesStable = state.dwellFramesStable;
      const dwellDurationMs = dwellElapsed;

      const hasEnoughDwell =
        dwellFramesStable >= DWELL_MIN_FRAMES &&
        dwellDurationMs >= DWELL_MIN_DURATION_MS;
      const dwellTimedOut = dwellDurationMs >= DWELL_MAX_DURATION_MS;

      if (hasEnoughDwell || dwellTimedOut) {
        const totalDistance = state.tapMaxDownDist;
        const totalDuration = tapDurationMs;
        const avgVelocity =
          totalDuration > 0 ? totalDistance / totalDuration : 0;

        const distanceOk = totalDistance >= minDistHard;
        const durationOk =
          tapDurationMs >= minDurHard && tapDurationMs <= MAX_DUR_HARD;
        const speedOk = state.tapPeakDownVel >= velMinHard;

        const passesHardGates =
          distanceOk &&
          durationOk &&
          totalDistance <= MAX_DIST_HARD;

        const confidence = computeTapConfidence({
          liftDistance: state.liftDistance,
          liftDurationMs: state.liftDurationMs,
          tapMaxDownDist: totalDistance,
          tapPeakDownVel: state.tapPeakDownVel,
          tapDurationMs: tapDurationMs,
          dwellFramesStable: dwellFramesStable,
          dwellDurationMs: dwellDurationMs,
        });

        const scoreOk = confidence >= tapScoreThreshold;
        const passedScore = scoreOk && passesHardGates;

        const candidate = {
          id: `${handIndex}-${fingerIndex}-${currT.toFixed(1)}`,
          handIndex,
          fingerIndex,
          fingerName: TAP_FINGERTIP_NAMES[fingerIndex] || `LM${fingerIndex}`,
          timestamp: currT,
          totalDurationMs: tapDurationMs,
          dwellFrames: dwellFramesStable,
          dwellDurationMs: dwellDurationMs,
          startY: state.tapStartY,
          endY: currY,
          motionLength: totalDistance,
          speed: state.tapPeakDownVel,
          avgVelocity: avgVelocity,
          decelMetric: 0,
          score: confidence,
          passedScoreThreshold: passedScore,
          scoreThreshold: tapScoreThreshold,
          distanceOk,
          durationOk,
          speedOk,
          hardGatesPassed: passesHardGates,
          scoreOk,
          rejectReasons: !passedScore
            ? [
                !distanceOk && "distance",
                !speedOk && "speed",
                !durationOk && "duration",
                (distanceOk && speedOk && durationOk && !scoreOk) && "score",
              ].filter(Boolean)
            : [],
        };

        if (onTapCandidateCallback) {
          onTapCandidateCallback(candidate);
        }

        const baselineYNow = state.baselineY;
        resetFingerState(state);
        state.baselineY = baselineYNow;

        if (passedScore && canFireTap(handIndex, fingerIndex, currT)) {
          tapEvent = candidate;

          if (vUp > upExitVel) {
            state.phase = "lift";
            state.liftStartY = currY;
            state.liftStartTime = currT;
            state.liftMaxY = currY;
          }
        } else {
          if (vUp > upExitVel) {
            const baselineYNow2 = state.baselineY;
            resetFingerState(state);
            state.baselineY = baselineYNow2;
            state.phase = "lift";
            state.liftStartY = currY;
            state.liftStartTime = currT;
            state.liftMaxY = currY;
          }
        }
      } else {
        if (vUp > upExitVel) {
          const baselineYNow = state.baselineY;
          resetFingerState(state);
          state.baselineY = baselineYNow;
          state.phase = "lift";
          state.liftStartY = currY;
          state.liftStartTime = currT;
          state.liftMaxY = currY;
        }
      }

      break;
    }

    default: {
      resetFingerState(state);
      break;
    }
  }

  const newPhase = state.phase || "idle";
  if (onPhaseChangeCallback && prevPhase !== newPhase) {
    onPhaseChangeCallback({
      handIndex,
      fingerIndex,
      fromPhase: prevPhase,
      toPhase: newPhase,
      timestamp: currT,
    });
  }

  return tapEvent;
}

///////////////////////////
// Public API functions  //
///////////////////////////

export function initTapDetection(options = {}) {
  const {
    onTap,
    onTapCandidate,
    onPhaseChange,
    velocityThreshold,
    distanceThreshold,
    scoreThreshold,
  } = options;

  onTapCallback = typeof onTap === "function" ? onTap : null;
  onTapCandidateCallback =
    typeof onTapCandidate === "function" ? onTapCandidate : null;
  onPhaseChangeCallback =
    typeof onPhaseChange === "function" ? onPhaseChange : null;

  if (typeof velocityThreshold === "number") {
    tapVelocityThreshold = velocityThreshold;
  }
  if (typeof distanceThreshold === "number") {
    minTapDistance = distanceThreshold;
  }
  if (typeof scoreThreshold === "number") {
    tapScoreThreshold = scoreThreshold;
  }

  updateDerivedThresholds();
  initTapState();
}

export function setTapThresholds({
  velocityThreshold,
  distanceThreshold,
  scoreThreshold,
} = {}) {
  if (typeof velocityThreshold === "number") {
    tapVelocityThreshold = velocityThreshold;
  }
  if (typeof distanceThreshold === "number") {
    minTapDistance = distanceThreshold;
  }
  if (typeof scoreThreshold === "number") {
    tapScoreThreshold = scoreThreshold;
  }
  updateDerivedThresholds();
}

// Prepare history/state
function initTapState() {
  tapHistory = { 0: {}, 1: {} };
  tapStates = { 0: {}, 1: {} };
  lastTapTime = { 0: {}, 1: {} };
}

export function updateTapFromLandmarks(landmarks, handIndex, timestampMs) {
  if (!landmarks || !landmarks.length) return;
  const t = timestampMs;

  for (const lmIndex of TAP_FINGERTIP_INDICES) {
    if (!ENABLED_FINGERS[lmIndex]) continue;
    const lm = landmarks[lmIndex];
    if (!lm) continue;

    const history = ensureHistory(handIndex, lmIndex);
    history.push({ time: t, y: lm.y });

    const cutoff = t - HISTORY_WINDOW_MS;
    while (history.length && history[0].time < cutoff) {
      history.shift();
    }

    if (history.length < MIN_HISTORY_SAMPLES) continue;
  }
}

export function runTapDetectionFrame(timestampMs) {
  const t = timestampMs;

  for (const handIndexStr of Object.keys(tapHistory)) {
    const handIndex = parseInt(handIndexStr, 10);
    const handHist = tapHistory[handIndex];
    if (!handHist) continue;

    for (const lmIndexStr of Object.keys(handHist)) {
      const lmIndex = parseInt(lmIndexStr, 10);
      if (!ENABLED_FINGERS[lmIndex]) continue;

      const history = handHist[lmIndex];
      if (!history || history.length < MIN_HISTORY_SAMPLES) continue;

      const state = ensureFingerState(handIndex, lmIndex);
      const tapEvent = updateFingerStateForTap(
        handIndex,
        lmIndex,
        history,
        state
      );

      if (tapEvent && onTapCallback) {
        onTapCallback(tapEvent);
      }
    }
  }
}
