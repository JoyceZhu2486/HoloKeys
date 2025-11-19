// tap.js
// Raw-landmark-based tap detection using vertical fingertip motion over time.

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

// Suppression: if both fire at same time on same hand,
// the dominant finger suppresses the submissive.
const FINGER_SUPPRESSION_HIERARCHY = {
  // ring (16) suppresses pinky (20)
  16: 20
};

// History / timing constants
const TAP_HISTORY_LENGTH       = 5;      // frames stored per fingertip
const TAP_DEBOUNCE_DELAY       = 500;    // ms between taps (global)
const TAP_STOP_VEL_THRESHOLD   = 0.0005; // y-units/ms considered "stopped"
const TAP_MIN_DURATION_MS      = 30;     // ms minimum tap duration
const TAP_MAX_VELOCITY         = 0.005;  // y-units/ms upper bound to filter glitches

// Tunable thresholds (overridden by initTapDetection / setTapThresholds)
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

// Optional callback to app
let onTapCallback = null;

// ---------- Internal helpers ----------

function initTapState(){
  for (let handIndex = 0; handIndex < 2; handIndex++) {
    TAP_FINGERTIP_INDICES.forEach(fingerIndex => {
      tapHistory[handIndex][fingerIndex] = [];
      tapStates[handIndex][fingerIndex] = {
        active: false,
        peakSpeed: 0,
        startY: 0,
        startTimestamp: 0
      };
    });
  }
  lastTapTime = 0;
}

/**
 * Record motion for one hand's landmarks at a given time.
 * Uses normalized landmark.y (0..1).
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

      history.push({ y: fingerTip.y, time: timestampMs });

      if (history.length > TAP_HISTORY_LENGTH) {
        history.shift();
      }
    }
  });
}

/**
 * Approximate instantaneous vertical velocity using a few frames back.
 * Returns y-units per ms, only for downward motion (increasing y).
 */
function calculateInstantVelocity(history, lookbackFrames = 3){
  if (!history || history.length <= lookbackFrames) return 0;

  const current  = history[history.length - 1];
  const previous = history[history.length - lookbackFrames];

  const deltaY    = current.y - previous.y;
  const deltaTime = current.time - previous.time;

  if (deltaTime <= 0 || deltaY <= 0) return 0;
  return deltaY / deltaTime;
}

/**
 * Core tap state machine: examines all fingertips & returns potential tap events.
 */
function checkForTap(timestampMs){
  const potentialTapEvents = [];

  const canStartNewTap = (timestampMs - lastTapTime) > TAP_DEBOUNCE_DELAY;

  for (let handIndex = 0; handIndex < 2; handIndex++) {
    const handTipHistories = tapHistory[handIndex];
    const handStates       = tapStates[handIndex];
    if (!handTipHistories || !handStates) continue;

    for (const fingerIndex of TAP_FINGERTIP_INDICES) {
      const history = handTipHistories[fingerIndex];
      const state   = handStates[fingerIndex];
      if (!history || !state) continue;

      if (history.length < TAP_HISTORY_LENGTH) continue;

      const speed = calculateInstantVelocity(history, 3);

      if (!state.active) {
        // Tap start: speed above threshold, but below max to filter glitches
        if (canStartNewTap &&
            speed > tapVelocityThreshold &&
            speed < TAP_MAX_VELOCITY) {
          state.active         = true;
          state.peakSpeed      = speed;
          state.startY         = history[history.length - 1].y;
          state.startTimestamp = timestampMs;
        }
      } else {
        // Track peak speed while active
        if (speed > state.peakSpeed) {
          state.peakSpeed = speed;
        }

        const timeSinceStart = timestampMs - state.startTimestamp;

        // Tap end condition
        if (speed < TAP_STOP_VEL_THRESHOLD &&
            timeSinceStart > TAP_MIN_DURATION_MS) {

          const totalYDrop =
            history[history.length - 1].y - state.startY;

          // Final success condition
          if (totalYDrop > minTapDistance &&
              state.peakSpeed > tapVelocityThreshold) {
            potentialTapEvents.push({
              handIndex,
              fingerIndex,
              timestamp: timestampMs,
              speed: state.peakSpeed,
              motionLength: totalYDrop,
              fingerName: TAP_FINGERTIP_NAMES[fingerIndex] ||
                          `LM${fingerIndex}`
            });
          }

          // Reset state regardless of success
          state.active    = false;
          state.peakSpeed = 0;
        }
      }
    }
  }

  return potentialTapEvents;
}

/**
 * Apply suppression (e.g., ring > pinky) and call onTap for final taps.
 */
function processTapEvents(potentialTaps){
  if (!potentialTaps || potentialTaps.length === 0) return [];

  const tapsByKey = potentialTaps.reduce((acc, tap) => {
    const key = `${tap.handIndex}-${tap.fingerIndex}`;
    acc[key] = tap;
    return acc;
  }, {});

  // Apply finger suppression on each hand
  for (const [dominantIndexStr, submissiveIndex] of Object.entries(FINGER_SUPPRESSION_HIERARCHY)) {
    const dominantIndex = parseInt(dominantIndexStr, 10);

    for (let handIndex = 0; handIndex < 2; handIndex++) {
      const dominantKey   = `${handIndex}-${dominantIndex}`;
      const submissiveKey = `${handIndex}-${submissiveIndex}`;

      if (tapsByKey[dominantKey] && tapsByKey[submissiveKey]) {
        // Suppress the submissive tap (e.g., pinky)
        delete tapsByKey[submissiveKey];
      }
    }
  }

  const finalTaps = Object.values(tapsByKey);

  // Call the callback for each tap
  if (onTapCallback) {
    finalTaps.forEach(tap => onTapCallback(tap));
  }

  // Update debounce time (any tap blocks new taps for a short time)
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
 *   velocityThreshold?: number,
 *   distanceThreshold?: number
 * }
 */
export function initTapDetection(options = {}){
  const {
    onTap,
    velocityThreshold,
    distanceThreshold
  } = options;

  if (typeof onTap === 'function') {
    onTapCallback = onTap;
  }

  if (typeof velocityThreshold === 'number') {
    tapVelocityThreshold = velocityThreshold;
  }
  if (typeof distanceThreshold === 'number') {
    minTapDistance = distanceThreshold;
  }

  initTapState();
}

/**
 * Dynamically update thresholds (used by UI controls).
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
  const potentialTaps = checkForTap(timestampMs);
  const finalTaps = processTapEvents(potentialTaps);
  return finalTaps;
}
