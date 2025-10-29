// fingertips.js — MediaPipe Hands + fingertip strategies (M1/M2/M5)
import { video } from './camera.js';

// pull DOM settings (thresholds & method) from the page (same names you used)
const selectMethod = document.getElementById('selectMethod');
const inputGradientThreshold = document.getElementById('inputGradientThreshold');
const inputExtensionFactor = document.getElementById('inputExtensionFactor');
const tempCanvas = document.getElementById('tempCanvas');
const tctx = tempCanvas.getContext('2d');

let handLandmarker = null;
let lastVideoTime = -1;

// Constants from your V22 page, with MAX_SEARCH halved to 30
const M5_MAX_SEARCH_DIST = 30;    // your latest setting
const M5_LOOKAHEAD = 5;
const M5_MIN_SUCCESS_DIST = 5;

const FINGERTIP_MAP = {
  4:  { name: "Thumb",  base: 3 },
  8:  { name: "Index",  base: 7 },
  12: { name: "Middle", base: 11 },
  16: { name: "Ring",   base: 15 },
  20: { name: "Pinky",  base: 19 }
};

// ---- color math (RGB+HSL) from your page ----
function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h,s,l=(max+min)/2;
  if (max===min){ h=s=0; }
  else{
    const d=max-min;
    s=l>0.5? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h=(g-b)/d+(g<b?6:0); break;
      case g: h=(b-r)/d+2; break;
      case b: h=(r-g)/d+4; break;
    }
    h/=6;
  }
  return [h*360, s, l];
}
function colorDiff(r1,g1,b1,r2,g2,b2){
  const dr=(r1-r2)/255, dg=(g1-g2)/255, db=(b1-b2)/255;
  const rgbDist=Math.hypot(dr,dg,db);
  const [h1,s1,l1] = rgbToHsl(r1,g1,b1);
  const [h2,s2,l2] = rgbToHsl(r2,g2,b2);
  let dh = Math.abs(h1-h2); if (dh>180) dh = 360-dh; dh/=180;
  const ds=Math.abs(s1-s2), dl=Math.abs(l1-l2);
  return (rgbDist*0.5) + (dh*0.25) + (ds*0.125) + (dl*0.125);
}

// ---- ROI along finger direction (used by M2 & M5) ----
function calcROI(landmarks, tipIdx, baseIdx, W, H){
  if (!landmarks || landmarks.length <= Math.max(tipIdx, baseIdx)) return null;
  const tip = landmarks[tipIdx], base = landmarks[baseIdx];
  const pTip = { x: tip.x * W,  y: tip.y * H };
  const pBase= { x: base.x* W,  y: base.y* H };
  const vx = pTip.x - pBase.x, vy = pTip.y - pBase.y;
  const L = Math.hypot(vx,vy); if (L<1) return null;
  const ux = vx/L, uy = vy/L;
  const ext = parseFloat(inputExtensionFactor.value) || 0.35;
  const proj = { x: pTip.x + ux * (L*ext), y: pTip.y + uy * (L*ext) };
  return { tip:pTip, unit:{x:ux,y:uy}, proj };
}

function findGradientTip(roi, W, H){
  const thr = (parseInt(inputGradientThreshold.value,10) || 30)/255;
  tempCanvas.width = W; tempCanvas.height = H;
  tctx.drawImage(video, 0, 0, W, H);
  const data = tctx.getImageData(0,0,W,H).data;

  let found = null;
  for (let d=1; d<M5_MAX_SEARCH_DIST; d++){
    const x  = Math.round(roi.tip.x + roi.unit.x * d);
    const y  = Math.round(roi.tip.y + roi.unit.y * d);
    const xa = Math.round(roi.tip.x + roi.unit.x * (d + M5_LOOKAHEAD));
    const ya = Math.round(roi.tip.y + roi.unit.y * (d + M5_LOOKAHEAD));
    if (x<0||x>=W||y<0||y>=H||xa<0||xa>=W||ya<0||ya>=H) break;
    const i  = (y*W + x)*4, ia=(ya*W + xa)*4;
    const diff = colorDiff(data[i],data[i+1],data[i+2], data[ia],data[ia+1],data[ia+2]);
    if (diff > thr && d > M5_MIN_SUCCESS_DIST) { found = { x, y, source:'Gradient (M5)' }; break; }
  }
  return found || { x: roi.proj.x, y: roi.proj.y, source:'Fallback (M2)' };
}

// ---- Public API ----
export async function initHands() {
  const { HandLandmarker, FilesetResolver } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs");
  const resolver = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm");
  handLandmarker = await HandLandmarker.createFromOptions(resolver, {
    baseOptions: { modelAssetPath:
      "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task"
    },
    runningMode: "VIDEO",
    numHands: 2
  });
}

export function detect() {
  if (!handLandmarker || video.readyState < 2) return null;
  const now = performance.now();
  if (video.currentTime === lastVideoTime) return null;
  lastVideoTime = video.currentTime;
  return handLandmarker.detectForVideo(video, now);
}

// Return refined fingertip points [{x,y,tag,source}, ...] in screen coords (overlay space)
export function refineFingertips(result, W, H, mirrorPreview=false) {
  if (!result?.landmarks?.length) return [];
  const tips = [];
  for (const hand of result.landmarks) {
    for (const idx of Object.keys(FINGERTIP_MAP)) {
      const { name, base } = FINGERTIP_MAP[idx];
      const roi = calcROI(hand, parseInt(idx,10), base, W, H);
      if (!roi) continue;
      const method = selectMethod.value;
      let pt;
      if (method === 'LANDMARK_TIP') {
        pt = { x: roi.tip.x, y: roi.tip.y, source:'Landmark Tip (M1)' };
      } else if (method === 'PROJECTION') {
        pt = { x: roi.proj.x, y: roi.proj.y, source:'Projection (M2)' };
      } else {
        pt = findGradientTip(roi, W, H); // M5 + fallback
      }
      const x = mirrorPreview ? (W - pt.x) : pt.x;
      tips.push({ x, y: pt.y, finger:name, source:pt.source, tag:name });
    }
  }
  return tips;
}
