// pressure.js
// Lightweight Web Serial bridge for pressure-sensor taps from Arduino.
// Expected serial format (newline-delimited):
//   handIndex, sensorIndex, state
// Example lines:
//   0,1,tapped
//   0,1,idle
// If your Arduino only sends sensorIndex + state, handIndex defaults to 0.

const FINGER_NAMES = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
const FINGER_TO_LANDMARK = { Thumb: 4, Index: 8, Middle: 12, Ring: 16, Pinky: 20 };

// Parse a single line of serial text into a tap event.
function parseLine(line) {
  if (!line) return null;
  const parts = line.split(/[,\s]+/).filter(Boolean);
  if (!parts.length) return null;

  let handIndex = 0;
  let sensorIndex = null;
  let state = null;

  if (parts.length === 1) {
    // state only
    state = parts[0];
  } else if (parts.length === 2) {
    // sensorIndex, state
    sensorIndex = Number(parts[0]);
    state = parts[1];
  } else {
    // handIndex, sensorIndex, state (ignore extra tokens)
    handIndex = Number(parts[0]);
    sensorIndex = Number(parts[1]);
    state = parts[2];
  }

  if (sensorIndex == null || Number.isNaN(sensorIndex)) sensorIndex = 0;
  const fingerName = FINGER_NAMES[sensorIndex] || 'Index';
  const fingerIndex = FINGER_TO_LANDMARK[fingerName];

  const normalizedState = (state || '').toLowerCase();
  return {
    handIndex: Number.isFinite(handIndex) ? handIndex : 0,
    sensorIndex,
    fingerName,
    fingerIndex,
    state: normalizedState
  };
}

// Determine whether a parsed event counts as a tap edge.
function isTapped(state) {
  if (!state) return false;
  const s = state.toLowerCase();
  return s === 'tapped' || s === 'tap' || s === 'pressed' || s === '1' || s === 'down';
}

// Open Web Serial and stream events. Returns a disconnect function.
export async function connectPressureSensors({
  baudRate = 115200,
  onTap,
  onState,
  forcedHandIndex = null
} = {}) {
  if (!('serial' in navigator)) {
    throw new Error('Web Serial not supported in this browser.');
  }

  const port = await navigator.serial.requestPort();
  await port.open({ baudRate });

  const textDecoder = new TextDecoderStream();
  const readableClosed = port.readable.pipeTo(textDecoder.writable);
  const reader = textDecoder.readable.getReader();

  let buffer = '';
  let active = true;

  (async () => {
    try {
      while (active) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        buffer += value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const raw of lines) {
          const evt = parseLine(raw.trim());
          if (!evt) continue;
          if (forcedHandIndex !== null) {
            evt.handIndex = forcedHandIndex;
          }

          if (typeof onState === 'function') onState(evt);
          if (isTapped(evt.state) && typeof onTap === 'function') onTap(evt);
        }
      }
    } catch (err) {
      console.error('Pressure sensor read error', err);
    } finally {
      reader.releaseLock();
    }
  })();

  // Return a disconnect helper
  return async function disconnect() {
    active = false;
    try { await reader.cancel(); } catch (_) {}
    try { await readableClosed.catch(() => {}); } catch (_) {}
    try { await port.close(); } catch (_) {}
  };
}
