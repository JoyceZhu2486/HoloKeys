// camera.js — camera control + snapshot + mirroring
export const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const frameCanvas = document.getElementById('frame');
const frameCtx = frameCanvas.getContext('2d', { willReadFrequently: true });

const camSel = document.getElementById('cameraSelect');
const btnStop = document.getElementById('btnStop');
let stream = null;
let currentDeviceId = null;
let usingFront = false;
const stage = document.getElementById('stage');

function applyStageSize() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return;

  // Size the container so absolutely-positioned children are visible
  stage.style.width  = w + 'px';
  stage.style.height = h + 'px';

  // Make the video and overlay visually match the pixel buffer
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
  if (currentDeviceId) camSel.value = currentDeviceId;
}

export function stopStream() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  btnStop.disabled = true;
}

export async function startStream(constraints) {
  stopStream();
  stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;

  // Wait for metadata so videoWidth/Height are valid
  await new Promise(res => {
    const onReady = () => { video.removeEventListener('loadedmetadata', onReady); res(); };
    video.addEventListener('loadedmetadata', onReady);
  });
  await video.play();

  applyStageSize();                    // <-- set sizes right away
  btnStop.disabled = false;
  await listCameras();

  usingFront = constraints?.video?.facingMode === 'user'
            || constraints?.video?.facingMode?.ideal === 'user';
  state.usingFront = usingFront;

  // Mirror preview for front camera
  video.style.transform = usingFront ? 'scaleX(-1)' : 'none';
  overlay.style.transform = 'none';

  // Also re-apply if the stream changes dimensions (rare but safe)
  video.addEventListener('resize', applyStageSize);
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
  video.addEventListener('playing', () => requestAnimationFrame(pump));
}

camSel.addEventListener('change', async () => { await selectDevice(camSel.value); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopStream(); });
window.addEventListener('pagehide', stopStream);
