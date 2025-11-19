// camera.js — camera control + snapshot + mirroring
export const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const frameCanvas = document.getElementById('frame');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

// Exported so app.js can wire the selector
export const camSel = document.getElementById('cameraSelect');
const btnStop = document.getElementById('btnStop');
let stream = null;
let currentDeviceId = null;
let usingFront = false;
const stage = document.getElementById('stage');

function applyStageSize() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  stage.style.width  = w + 'px';
  stage.style.height = h + 'px';

  video.style.width  = w + 'px';
  video.style.height = h + 'px';
  overlay.style.width  = w + 'px';
  overlay.style.height = h + 'px';
}

export const state = { usingFront: false };

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter(d => d.kind === 'videoinput');
  camSel.innerHTML = '';
  cams.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Camera ${i+1}`;
    camSel.appendChild(opt);
  });
  if (cams.length) {
    currentDeviceId = cams[0].deviceId;
    camSel.value = currentDeviceId;
  }
  return cams.length;
}

export function stopStream() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
  }
  stream = null;
  video.srcObject = null;
  video.style.transform = 'scale(1)';
  state.usingFront = false;
}

async function startStream(constraints) {
  if (stream) stopStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.warn(`Error getting exact constraints (${err.message}). Trying default.`);
    const simpleConstraints = { video: true, audio: false };
    stream = await navigator.mediaDevices.getUserMedia(simpleConstraints);
  }

  video.srcObject = stream;
  state.usingFront = constraints?.video?.facingMode?.ideal === 'user';
  video.style.transform = state.usingFront ? 'scale(-1, 1)' : 'scale(1, 1)';
  await video.play();
  video.addEventListener('loadedmetadata', applyStageSize);
}

export async function startRear() {
  return startStream({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } },
    audio: false
  });
}
export async function startFront() {
  return startStream({
    video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 60 } },
    audio: false
  });
}

export async function selectDevice(deviceId) {
  currentDeviceId = deviceId;
  return startStream({ video: { deviceId: { exact: currentDeviceId } }, audio: false });
}

export async function captureJpeg({quality=0.92}={}) {
  const w = video.videoWidth, h = video.videoHeight;
  frameCanvas.width = w; frameCanvas.height = h;
  if (state.usingFront) {
    frameCtx.save(); frameCtx.scale(-1,1); frameCtx.drawImage(video, -w, 0, w, h); frameCtx.restore();
  } else {
    frameCtx.drawImage(video, 0, 0, w, h);
  }
  return new Promise(res => frameCanvas.toBlob(res, 'image/jpeg', quality));
}

export function onVideoFrame(cb) {
  function pump() {
    if (!stream) return;
    cb();
    requestAnimationFrame(pump);
  }
  requestAnimationFrame(pump);
}
