// fingertips.js — MediaPipe Hands + fingertip strategies (M5 + M2 fallback)
// Adds handedness tags so calibration can lock F=Left Index, J=Right Index.
import { video } from './camera.js';

const tempCanvas = document.getElementById('tempCanvas');
const tctx = tempCanvas.getContext('2d', { willReadFrequently: true });

let handLandmarker = null;
let lastVideoTime = -1;

// Tunings from Version A
const M5_MAX_SEARCH_DIST = 30;
const M5_LOOKAHEAD = 5;
const M5_MIN_SUCCESS_DIST = 5;
const M5_GRADIENT_THRESHOLD = 30;
const M2_EXTENSION_FACTOR = 0.35;

const FINGERTIP_MAP = {
  4:  { name: "Thumb",  base: 3 },
  8:  { name: "Index",  base: 7 },
  12: { name: "Middle", base: 11 },
  16: { name: "Ring",   base: 15 },
  20: { name: "Pinky",  base: 19 }
};

// ---------- Color / gradient helpers ----------
function rgbToHsl(r,g,b){
  r/=255; g/=255; b/=255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h,s,l=(max+min)/2;
  if (max===min){ h=s=0; }
  else{
    const d=max-min; s=l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){ case r:h=(g-b)/d+(g<b?6:0);break; case g:h=(b-r)/d+2;break; case b:h=(r-g)/d+4;break; }
    h/=6;
  }
  return {h:h*360, s, l};
}
function colorDiff(r1,g1,b1, r2,g2,b2){
  const dr=r1-r2, dg=g1-g2, db=b1-b2;
  const rgbDist = Math.sqrt(dr*dr+dg*dg+db*db); // 0..441
  const hsl1=rgbToHsl(r1,g1,b1), hsl2=rgbToHsl(r2,g2,b2);
  let hDiff=Math.abs(hsl1.h-hsl2.h); if (hDiff>180) hDiff=360-hDiff; hDiff/=180;
  const sDiff=Math.abs(hsl1.s-hsl2.s), lDiff=Math.abs(hsl1.l-hsl2.l);
  return ((rgbDist/441)*0.5 + hDiff*0.25 + sDiff*0.125 + lDiff*0.125) * 255;
}

// ---------- ROI / search ----------
function calcROI(landmarks, tipIdx, baseIdx, W, H){
  if (!landmarks || landmarks.length<=tipIdx || landmarks.length<=baseIdx) return null;
  const tip = landmarks[tipIdx], base = landmarks[baseIdx];
  const pTip = { x: tip.x * W, y: tip.y * H };
  const pBase= { x: base.x* W, y: base.y* H };
  const v = { x:pTip.x-pBase.x, y:pTip.y-pBase.y };
  const len = Math.hypot(v.x,v.y); if (len<1) return null;
  const unit={ x:v.x/len, y:v.y/len };
  return { tip:pTip, base:pBase, unit, len };
}
function findM5Point(roi, W, H) {
  const startD = Math.max(0, roi.len * (1.0 - M2_EXTENSION_FACTOR));
  const endD   = M5_MAX_SEARCH_DIST;

  tempCanvas.width=W; tempCanvas.height=H;
  tctx.drawImage(video,0,0,W,H);
  const data=tctx.getImageData(0,0,W,H).data;

  for (let d=startD; d<endD; d++){
    const x = Math.round(roi.tip.x + roi.unit.x * d);
    const y = Math.round(roi.tip.y + roi.unit.y * d);
    const xa= Math.round(roi.tip.x + roi.unit.x * (d + M5_LOOKAHEAD));
    const ya= Math.round(roi.tip.y + roi.unit.y * (d + M5_LOOKAHEAD));
    if (x<0||x>=W||y<0||y>=H||xa<0||xa>=W||ya<0||ya>=H) break;

    const i1=(y*W+x)*4, i2=(ya*W+xa)*4;
    const diff = colorDiff(data[i1],data[i1+1],data[i1+2], data[i2],data[i2+1],data[i2+2]);
    if (diff > M5_GRADIENT_THRESHOLD) {
      if (d > M5_MIN_SUCCESS_DIST) return { x, y, source: 'Gradient (M5)' };
      break;
    }
  }
  return { x: roi.tip.x + roi.unit.x * endD, y: roi.tip.y + roi.unit.y * endD, source: 'Fallback (M2)' };
}

// ---------- MediaPipe ----------
export async function initHands() {
  const { HandLandmarker, FilesetResolver } =
    await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.js");
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
  if (video.currentTime === lastVideoTime) return null;
  lastVideoTime = video.currentTime;
  return handLandmarker.detectForVideo(video, performance.now()); // {landmarks, handedness, ...}
}

// ---------- Refine + tag handedness ----------
export function refineFingertips(result, W, H, mirrorPreview=false) {
  if (!result?.landmarks?.length) return [];
  const tips = [];
  const hands = result.landmarks;
  const handedness = result.handedness || []; // array of arrays of categories

  for (let hi = 0; hi < hands.length; hi++) {
    const hand = hands[hi];
    const handLabel = (handedness[hi]?.[0]?.categoryName) || 'Unknown'; // 'Left' | 'Right' | 'Unknown'

    for (const idxStr of Object.keys(FINGERTIP_MAP)) {
      const idx = parseInt(idxStr, 10);
      const { name, base } = FINGERTIP_MAP[idx];

      // NOTE: previously we had:
      // if (name !== 'Index') continue;
      // That restricted us to Index only. Now we keep ALL fingers.

      const roi = calcROI(hand, idx, base, W, H);
      if (!roi) continue;

      let pt = findM5Point(roi, W, H);
      if (mirrorPreview) pt.x = W - pt.x;

      tips.push({
        x: pt.x,
        y: pt.y,
        finger: name,      // 'Thumb' | 'Index' | 'Middle' | 'Ring' | 'Pinky'
        tag: name[0],      // 'T', 'I', 'M', 'R', 'P'
        source: pt.source, // 'Gradient (M5)' or 'Fallback (M2)'
        handLabel,         // 'Left' | 'Right' | 'Unknown'
        handIndex: hi      // 0 or 1 for this frame
      });
    }
  }

  return tips;
}
