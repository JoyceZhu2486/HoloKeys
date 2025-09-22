// ======================
// Camera control (from your working code)
// ======================
const video   = document.getElementById('preview');
const startBtn = document.getElementById('start');
const stopBtn  = document.getElementById('stop');
const camSel   = document.getElementById('cameraSelect');

let stream = null;
let currentDeviceId = null;
let usingFront = false;

async function listCameras() {
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

function stopStream() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  stopBtn.disabled = true;
}

async function startStream(constraints) {
  try {
    stopStream();
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    stopBtn.disabled = false;
    await listCameras();
    usingFront = constraints?.video?.facingMode === 'user'
              || constraints?.video?.facingMode?.ideal === 'user';
    video.style.transform = usingFront ? 'scaleX(-1)' : 'none';
  } catch (err) {
    alert('Camera error: ' + (err?.name || err?.message || err));
    console.error(err);
  }
}

// UI hooks
startBtn.addEventListener('click', async () => {
  await startStream({
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
});
camSel.addEventListener('change', async () => {
  currentDeviceId = camSel.value;
  await startStream({ video: { deviceId: { exact: currentDeviceId } }, audio: false });
});
stopBtn.addEventListener('click', stopStream);

// ======================
// Snapshot capture
// ======================
async function captureJpegFromVideo(video, {width, height, quality = 0.92} = {}) {
  const w = width  ?? video.videoWidth;
  const h = height ?? video.videoHeight;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  return blob;
}
async function downloadSnapshot(video) {
  const blob = await captureJpegFromVideo(video, {quality: 0.92});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `frame-${ts}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
document.getElementById('snap').addEventListener('click', () => downloadSnapshot(video));

// ======================
// Homography calibration
// ======================
const WCM = 27.0, HCM = 10.0;
let overlay = document.getElementById('overlay');
let octx = overlay.getContext('2d');
let taps = [];
let H = null, Hinv = null;
let cvReady = false;

Module = Module || {};
Module['onRuntimeInitialized'] = () => {
  cvReady = true;
  console.log('OpenCV.js ready');
};

function resizeOverlay() {
  const rect = video.getBoundingClientRect();
  overlay.width = rect.width * devicePixelRatio;
  overlay.height = rect.height * devicePixelRatio;
  octx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  drawOverlay();
}
video.addEventListener('loadedmetadata', resizeOverlay);
window.addEventListener('resize', resizeOverlay);

overlay.addEventListener('click', onOverlayClick);

function onOverlayClick(e) {
  const r = overlay.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const ix = cx * (video.videoWidth / r.width);
  const iy = cy * (video.videoHeight / r.height);
  taps.push({ x: ix, y: iy, cx, cy });
  if (taps.length === 4) computeHomography();
  drawOverlay();
}

function computeHomography() {
  if (!cvReady || taps.length !== 4) return;
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, new Float32Array([
    taps[0].x, taps[0].y,
    taps[1].x, taps[1].y,
    taps[2].x, taps[2].y,
    taps[3].x, taps[3].y
  ]));
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, new Float32Array([
    0,0, WCM,0, WCM,HCM, 0,HCM
  ]));
  const mask = new cv.Mat();
  const Hmat = cv.findHomography(src, dst, cv.RANSAC, 3.0, mask);
  src.delete(); dst.delete(); mask.delete();
  if (H) H.delete();
  if (Hinv) Hinv.delete();
  H = Hmat;
  Hinv = new cv.Mat();
  cv.invert(H, Hinv, cv.DECOMP_LU);
  console.log('Homography computed hehe');
}

// function drawOverlay() {
//   octx.clearRect(0,0,overlay.width,overlay.height);
//   // Draw taps
//   octx.fillStyle = 'red';
//   taps.forEach(t => {
//     octx.beginPath();
//     octx.arc(t.cx, t.cy, 6, 0, Math.PI*2);
//     octx.fill();
//   });
//   // Connect taps
//   if (taps.length > 1) {
//     octx.strokeStyle = 'red'; octx.lineWidth = 2;
//     octx.beginPath();
//     octx.moveTo(taps[0].cx, taps[0].cy);
//     for (let i=1;i<taps.length;i++) octx.lineTo(taps[i].cx, taps[i].cy);
//     octx.stroke();
//   }
// }


function drawOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
  
    // === Draw taps ===
    octx.fillStyle = 'red';
    taps.forEach(t => {
      octx.beginPath();
      octx.arc(t.cx, t.cy, 6, 0, Math.PI * 2);
      octx.fill();
    });
  
    // Connect taps
    if (taps.length > 1) {
      octx.strokeStyle = 'red';
      octx.lineWidth = 2;
      octx.beginPath();
      octx.moveTo(taps[0].cx, taps[0].cy);
      for (let i = 1; i < taps.length; i++) octx.lineTo(taps[i].cx, taps[i].cy);
      octx.stroke();
    }
  
    // === Draw projected rectangle + grid if homography exists ===
    if (H && Hinv) {
      octx.strokeStyle = 'rgba(0, 128, 255, 0.7)';
      octx.lineWidth = 1.5;
  
      // Helper: plane coords -> video overlay coords
      function projectPoints(ptsPlane) {
        const arr = new Float32Array(ptsPlane.flatMap(p => [p.x, p.y]));
        const src = cv.matFromArray(ptsPlane.length, 1, cv.CV_32FC2, arr);
        const dst = new cv.Mat();
        cv.perspectiveTransform(src, dst, Hinv);
  
        const r = overlay.getBoundingClientRect();
        const sx = r.width / video.videoWidth;
        const sy = r.height / video.videoHeight;
  
        const pts = [];
        for (let i = 0; i < ptsPlane.length; i++) {
          pts.push({
            cx: dst.data32F[2 * i] * sx,
            cy: dst.data32F[2 * i + 1] * sy
          });
        }
        src.delete(); dst.delete();
        return pts;
      }
  
      // Outer rectangle (keyboard plane)
      const rectPts = projectPoints([
        {x: 0, y: 0},
        {x: WCM, y: 0},
        {x: WCM, y: HCM},
        {x: 0, y: HCM}
      ]);
      octx.beginPath();
      octx.moveTo(rectPts[0].cx, rectPts[0].cy);
      rectPts.forEach(p => octx.lineTo(p.cx, p.cy));
      octx.closePath();
      octx.stroke();
  
      // Vertical grid lines
      for (let c = 1; c < 6; c++) {
        const x = (WCM * c) / 6;
        const pts = projectPoints([{x, y: 0}, {x, y: HCM}]);
        octx.beginPath();
        octx.moveTo(pts[0].cx, pts[0].cy);
        octx.lineTo(pts[1].cx, pts[1].cy);
        octx.stroke();
      }
  
      // Horizontal grid lines
      for (let r = 1; r < 4; r++) {
        const y = (HCM * r) / 4;
        const pts = projectPoints([{x: 0, y}, {x: WCM, y}]);
        octx.beginPath();
        octx.moveTo(pts[0].cx, pts[0].cy);
        octx.lineTo(pts[1].cx, pts[1].cy);
        octx.stroke();
      }
    }
  }
  
