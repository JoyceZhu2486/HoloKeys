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

// History length and timing
const TAP_HISTORY_LENGTH = 15;       // samples per fingertip
const TAP_MAX_WINDOW_MS  = 600;      // max time from tap-descent start to dwell

// --- Lift (pre-tap) heuristics ---
// LIFT is easy to enter, just to avoid starting taps halfway down.
const LIFT_ENTER_DIST_BASE = 0.008;  // baselineY - currY > this ⇒ possible lift
const LIFT_ENTER_VEL_BASE  = 0.00008;// upward (negative) velocity threshold
const LIFT_TIMEOUT_MS      = 800;    // stay in LIFT at most this long

// --- Tap descent & dwell ---
// Base values before we tie them to sliders
const TAP_DOWN_DIST_MIN_BASE = 0.010;   // y-units from tapStartY
const DWELL_Y_RADIUS         = 0.004;   // allowed y deviation during dwell
const DWELL_VEL_THRESHOLD    = 0.00030; // |v| below this counts as "almost still"
const DWELL_MIN_FRAMES       = 2;       // consecutive stable frames
const DWELL_MIN_DURATION_MS  = 15;      // minimal dwell time
const DWELL_MAX_DURATION_MS  = 250;     // after this, force evaluation

// If we see a clear upward motion in dwell, exit to LIFT to prep next tap.
const UP_EXIT_VEL_BASE       = 0.00040; // upward velocity magnitude (negative)

// --- Soft / mild hard gates for tap candidates ---
// Very gentle; we rely mostly on the confidence score.
// We will ALSO use a **velocity** hard gate derived from the user's setting.
const MIN_DIST_FACTOR        = 0.6;     // minDistHard = MIN_DIST_FACTOR * minTapDistance
const MAX_DIST_HARD          = 0.45;    // above this likely a reach / big move
const MIN_DUR_HARD_BASE      = 35;      // ms, extremely fast "tap" below this is suspicious
const MAX_DUR_HARD           = 650;     // ms, above this is probably not a single tap

// --- Score threshold ---
// User can override via slider.
const DEFAULT_TAP_SCORE_THRESHOLD = 0.5;
let tapScoreThreshold = DEFAULT_TAP_SCORE_THRESHOLD;

// --- Tunable thresholds controlled by UI ---
// These get set via initTapDetection / setTapThresholds.
let tapVelocityThreshold = 0.00015;    // "fast downward" reference from slider
let minTapDistance       = 0.010;      // "typical tap distance" from slider

// --- Derived thresholds that depend on the above ---
let downEnterVel   = 0.00025; // actual velocity used to enter tap-descent
let tapDownDistMin = TAP_DOWN_DIST_MIN_BASE;
let minDistHard    = MIN_DIST_FACTOR * minTapDistance;
let minDurHard     = MIN_DUR_HARD_BASE;
let upExitVel      = UP_EXIT_VEL_BASE;
let velMinHard     = 0.00012; // minimal peak downward speed for a real tap

// Recompute derived thresholds whenever user changes sliders.
function updateDerivedThresholds() {
  // How easy it is to start tap descent:
  // slightly above user's "tap start speed" slider, but never absurdly high.
  downEnterVel = Math.max(
    tapVelocityThreshold * 1.8,
    tapVelocityThreshold * 0.8,
    0.00003
  );

  // Minimum downward distance before going into dwell:
  // allow taps slightly smaller than minTapDistance.
  tapDownDistMin = Math.max(0.004, minTapDistance * 0.8);

  // Mild "hard" minimum distance for a tap:
  // pick something that kills 0.004–0.005 I-taps but keeps 0.007–0.01 J-taps.
  minDistHard = Math.max(0.006, minTapDistance * MIN_DIST_FACTOR);

  // Mild minimum duration: scale a bit with minTapDistance (smaller motion may be quicker).
  minDurHard = Math.max(MIN_DUR_HARD_BASE * (minTapDistance / 0.01), 25);

  // Upward exit velocity: also related to tapVelocityThreshold so it scales.
  upExitVel = Math.max(UP_EXIT_VEL_BASE, tapVelocityThreshold * 2.0);

  // Velocity hard gate: real taps have peak speeds an order of magnitude
  // above jitter. Require at least ~8× slider or a small absolute floor.
  velMinHard = Math.max(tapVelocityThreshold * 8.0, 0.00012);
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
let onPhaseChangeCallback = null;  // NEW: FSM state change callback


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

  // Tap-descent
  state.tapStartY = 0;
  state.tapStartTime = 0;
  state.tapMaxDownDist = 0;
  state.tapPeakDownVel = 0;

  // Dwell
  state.dwellStartY = 0;
  state.dwellStartTime = 0;
  state.dwellFramesStable = 0;

  state.lastVelocitySigned = 0;

  if (baselineY != null) {
    state.baselineY = baselineY;
  } else if (typeof state.baselineY === "undefined") {
    state.baselineY = null;
  }
}

function initTapState() {
  tapHistory = { 0: {}, 1: {} };
  tapStates = { 0: {}, 1: {} };

  for (let h = 0; h < 2; h++) {
    TAP_FINGERTIP_INDICES.forEach((f) => {
      tapHistory[h][f] = [];
      const st = {};
      st.baselineY = null;
      resetFingerState(st);
      tapStates[h][f] = st;
    });
  }
}

function recordHandMotion(landmarks, handIndex, timestampMs) {
  if (!landmarks || handIndex == null) return;
  const histories = tapHistory[handIndex];
  if (!histories) return;

  TAP_FINGERTIP_INDICES.forEach((idx) => {
    if (landmarks.length > idx) {
      const tip = landmarks[idx];
      let hist = histories[idx];
      if (!hist) {
        hist = [];
        histories[idx] = hist;
      }
      hist.push({ y: tip.y, time: timestampMs });
      if (hist.length > TAP_HISTORY_LENGTH) hist.shift();
    }
  });
}

function computeSignedVelocity(history) {
  if (!history || history.length < 2) return 0;
  const n = history.length;
  const curr = history[n - 1];
  const prev = history[n - 2];
  const dt = curr.time - prev.time;
  if (dt <= 0) return 0;
  const dy = curr.y - prev.y;
  return dy / dt; // downward positive
}

//////////////////////////
// Confidence scoring   //
//////////////////////////

// Taps are recognized mostly from downward + dwell behavior,
// with lift giving a smaller boost.
function computeTapConfidence({
  liftDistance,
  liftDurationMs,
  tapMaxDownDist,
  tapPeakDownVel,
  tapDurationMs,
  dwellFramesStable,
  dwellDurationMs,
}) {
  // --- Lift (small weight) ---
  const liftTargetDist = Math.max(0.5 * minTapDistance, 0.006);
  const liftDistNorm = clamp(
    (liftDistance - liftTargetDist / 2) / (liftTargetDist || 1e-6),
    0,
    1
  );
  const liftTargetTime = 60;
  const liftTimeNorm = clamp(
    (liftDurationMs - liftTargetTime / 2) / (liftTargetTime || 1e-6),
    0,
    1
  );
  const liftScore = 0.6 * liftDistNorm + 0.4 * liftTimeNorm;

  // --- Downward leg (main) ---
  // Distance term: 0 until we pass a distFloor (~0.006–0.007), then up to 1.
  const distFloor = Math.max(minTapDistance * 0.6, 0.006);
  const distCeil  = Math.max(minTapDistance * 4.0, distFloor + 0.02);
  const tapDistNorm = clamp(
    (tapMaxDownDist - distFloor) / (distCeil - distFloor || 1e-6),
    0,
    1
  );

  // Velocity term: 0 until we pass velMinHard, then up to 1 by ~4×.
  const velFloor = velMinHard;
  const velCeil  = Math.max(velFloor * 4.0, velFloor + 0.0003);
  const tapVelNorm = clamp(
    (tapPeakDownVel - velFloor) / (velCeil - velFloor || 1e-6),
    0,
    1
  );

  let tapDurNorm = 0;
  if (tapDurationMs <= 0) tapDurNorm = 0;
  else if (tapDurationMs < 80) tapDurNorm = 0.5;      // snappy tap
  else if (tapDurationMs <= 350) tapDurNorm = 1;      // nice range
  else if (tapDurationMs <= MAX_DUR_HARD) tapDurNorm = 0.6;
  else tapDurNorm = 0.3;

  const tapScore =
    0.45 * tapDistNorm +
    0.40 * tapVelNorm +
    0.15 * tapDurNorm;

  // --- Dwell (contact) ---
  const dwellFramesNorm = clamp(
    (dwellFramesStable - DWELL_MIN_FRAMES) / 4,
    0,
    1
  );

  let dwellTimeNorm = 0;
  if (dwellDurationMs <= 0) dwellTimeNorm = 0;
  else if (dwellDurationMs < DWELL_MIN_DURATION_MS) dwellTimeNorm = 0;
  else if (dwellDurationMs <= 150) dwellTimeNorm = 1;
  else if (dwellDurationMs <= 300) dwellTimeNorm = 0.7;
  else dwellTimeNorm = 0.4;

  const dwellScore = 0.5 * dwellFramesNorm + 0.5 * dwellTimeNorm;

  // Weights: downward + dwell dominate, lift is assistive.
  const wL = 0.2;
  const wT = 0.5;
  const wD = 0.3;

  const confidence = wL * liftScore + wT * tapScore + wD * dwellScore;
  return clamp(confidence, 0, 1);
}

//////////////////////////
// FSM per fingertip    //
//////////////////////////

function updateFingerStateForTap(handIndex, fingerIndex, history, state) {
  if (!history || history.length < 2) return null;

  const n = history.length;
  const curr = history[n - 1];
  const currY = curr.y;
  const currT = curr.time;

  const prevPhase = state.phase || "idle";  // NEW: remember previous phase

  const vSigned = computeSignedVelocity(history);
  const vDown = vSigned > 0 ? vSigned : 0;
  const vUp = vSigned < 0 ? -vSigned : 0;

  // Initialize baseline if needed
  if (state.baselineY == null || Number.isNaN(state.baselineY)) {
    state.baselineY = currY;
  }

  // Slowly update baseline when idle and nearly still
  const absVel = Math.abs(vSigned);
  if (state.phase === "idle" && absVel < 0.0001) {
    state.baselineY = state.baselineY * 0.9 + currY * 0.1;
  }

  const baselineY = state.baselineY;
  const liftFromBaseline = baselineY - currY; // positive = lifted up

  switch (state.phase) {
    case "idle": {
      // Easy entry into LIFT: small upward movement or being above baseline
      if (
        liftFromBaseline > LIFT_ENTER_DIST_BASE ||
        vUp > LIFT_ENTER_VEL_BASE
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
      // Track how far & how long we've lifted
      if (currY < state.liftMaxY) state.liftMaxY = currY;
      state.liftDistance = baselineY - state.liftMaxY;
      state.liftDurationMs = currT - state.liftStartTime;

      // Timeout if staying in LIFT too long
      if (state.liftDurationMs > LIFT_TIMEOUT_MS) {
        resetFingerState(state);
        break;
      }

      // Count downward frames while in LIFT
      if (vDown > downEnterVel) {
        state.downFramesInLift += 1;
      } else {
        state.downFramesInLift = 0;
      }

      // Once we see sustained downward motion, enter tap-descent.
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
      const downDist = currY - state.tapStartY; // downward positive
      const elapsedMs = currT - state.tapStartTime;

      if (downDist > state.tapMaxDownDist) state.tapMaxDownDist = downDist;
      if (vDown > state.tapPeakDownVel) state.tapPeakDownVel = vDown;

      // Abort if we move strongly back up or take far too long
      if (downDist < -0.006 || elapsedMs > TAP_MAX_WINDOW_MS) {
        resetFingerState(state);
        break;
      }

      // Once we've moved enough downward and slowed, enter dwell
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

      // If we wander far away from dwell center, cancel
      if (!isStill && dy > DWELL_Y_RADIUS * 2) {
        resetFingerState(state);
        break;
      }

      const tapDurationMs = currT - state.tapStartTime;
      const dwellFramesStable = state.dwellFramesStable;
      const dwellDurationMs = dwellElapsed;

      // Decide when to evaluate a candidate
      const hasEnoughDwell =
        dwellFramesStable >= DWELL_MIN_FRAMES &&
        dwellDurationMs >= DWELL_MIN_DURATION_MS;
      const dwellTimedOut = dwellDurationMs >= DWELL_MAX_DURATION_MS;

      if (hasEnoughDwell || dwellTimedOut) {
        const totalDistance = state.tapMaxDownDist;
        const totalDuration = tapDurationMs;
        const avgVelocity =
          totalDuration > 0 ? totalDistance / totalDuration : 0;

        // Mild hard gates: distance, duration, and **peak speed**.
        const passesHardGates =
          totalDistance >= minDistHard &&
          totalDistance <= MAX_DIST_HARD &&
          tapDurationMs >= minDurHard &&
          tapDurationMs <= MAX_DUR_HARD &&
          state.tapPeakDownVel >= velMinHard;

        const confidence = computeTapConfidence({
          liftDistance: state.liftDistance,
          liftDurationMs: state.liftDurationMs,
          tapMaxDownDist: totalDistance,
          tapPeakDownVel: state.tapPeakDownVel,
          tapDurationMs: tapDurationMs,
          dwellFramesStable: dwellFramesStable,
          dwellDurationMs: dwellDurationMs,
        });

        const passedScore = confidence >= tapScoreThreshold && passesHardGates;

        const tapEvent = {
          id: `${handIndex}-${fingerIndex}-${currT.toFixed(1)}`,
          handIndex,
          fingerIndex,
          fingerName: TAP_FINGERTIP_NAMES[fingerIndex] || `LM${fingerIndex}`,

          // timing
          timestamp: currT,
          totalDurationMs: tapDurationMs,
          dwellFrames: dwellFramesStable,
          dwellDurationMs: dwellDurationMs,

          // motion
          startY: state.tapStartY,
          endY: currY,
          motionLength: totalDistance,
          speed: state.tapPeakDownVel,
          avgVelocity: avgVelocity,
          decelMetric: 0, // placeholder, not used for gating now

          // classifier
          score: confidence,
          passedScoreThreshold: passedScore,
          scoreThreshold: tapScoreThreshold,
        };

        if (onTapCandidateCallback) {
          onTapCandidateCallback(tapEvent);
        }

        // After evaluation, reset, and possibly go to new LIFT if releasing up
        const baselineYNow = state.baselineY;
        resetFingerState(state);
        state.baselineY = baselineYNow;

        if (passedScore) {
          // If finger is already moving up strongly, go straight into new lift.
          if (vUp > upExitVel) {
            state.phase = "lift";
            state.liftStartY = currY;
            state.liftStartTime = currT;
            state.liftMaxY = currY;
          }
          
          // --- After FSM update: log phase change, if any ---
          if (onPhaseChangeCallback && prevPhase !== state.phase) {
            onPhaseChangeCallback({
              handIndex,
              fingerIndex,
              fromPhase: prevPhase,
              toPhase: state.phase,
              timestamp: currT,
            });
          }

          return tapEvent;
        }

        // Not a confirmed tap ⇒ still watch for upward release into lift
        if (vUp > upExitVel) {
          state.phase = "lift";
          state.liftStartY = currY;
          state.liftStartTime = currT;
          state.liftMaxY = currY;
        }

        break;
      }

      // Even before evaluation, if we see a clear upward release, go to LIFT.
      if (vUp > upExitVel) {
        const baselineYNow = state.baselineY;
        resetFingerState(state);
        state.baselineY = baselineYNow;
        state.phase = "lift";
        state.liftStartY = currY;
        state.liftStartTime = currT;
        state.liftMaxY = currY;
      }

      break;
    }

    default: {
      resetFingerState(state);
      break;
    }
  }

  return null;
}

//////////////////////////
// Core detection loop  //
//////////////////////////

function checkForTap() {
  const potentialTapEvents = [];

  for (let h = 0; h < 2; h++) {
    const handHistory = tapHistory[h];
    const handStates = tapStates[h];
    if (!handHistory || !handStates) continue;

    for (const f of TAP_FINGERTIP_INDICES) {
      const history = handHistory[f];
      const state = handStates[f];
      if (!history || !state) continue;
      if (history.length < 2) continue;

      const tapEvent = updateFingerStateForTap(h, f, history, state);
      if (tapEvent) potentialTapEvents.push(tapEvent);
    }
  }

  return potentialTapEvents;
}

function processTapEvents(potentialTaps) {
  if (!potentialTaps || potentialTaps.length === 0) return [];

  // At most one tap per hand per frame: keep highest-scoring tap per hand.
  const bestByHand = {};
  for (const tap of potentialTaps) {
    const h = tap.handIndex;
    const prev = bestByHand[h];
    if (!prev || tap.score > prev.score) {
      bestByHand[h] = tap;
    }
  }

  const finalTaps = Object.values(bestByHand);
  if (onTapCallback) finalTaps.forEach((tap) => onTapCallback(tap));
  return finalTaps;
}

//////////////////////////
// Public API           //
//////////////////////////

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

export function updateTapFromLandmarks(landmarks, handIndex, timestampMs) {
  recordHandMotion(landmarks, handIndex, timestampMs);
}

export function runTapDetectionFrame(timestampMs) {
  const potentialTaps = checkForTap();
  const finalTaps = processTapEvents(potentialTaps);
  return finalTaps;
}
