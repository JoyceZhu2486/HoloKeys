// HoloKeys — Integrated calibration + keyboard overlay + fingertip detection (M1/M2/M5)

import {
  HandLandmarker,
  FilesetResolver,
  DrawingUtils
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.mjs";

/* ===== DOM ===== */
const video   = document.getElementById('preview');
const overlay = document.getElementById('overlay');
const octx    = overlay.getContext('2d');

const startBtn = document.getElementById('start');
const stopBtn  = document.getElementById('stop');
const camSel   = document.getElementById('cameraSelect');
const snapBtn  = document.getElementById('snap');
const liveChk  = document.getElementById('live');
const showHandsChk = document.getElementById('showHands');
const showDebugChk = document.getElementById('showDebug');
const blackChk = document.getElementById('blackMode');
const recalBtn = document.getElementById('recalibrate');
const statusEl = document.getElementById('status');

const heightSlider = document.getElementById('height');
const heightVal    = document.getElementById('heightVal');
const ratioSlider  = document.getElementById('ratio');
const ratioVal     = document.getElementById('ratioVal');

const heightDefaultBtn = document.getElementById('heightDefault');
const ratioDefaultBtn  = document.getElementById('ratioDefault');

const frameCanvas = document.getElementById('frame');
const fctx        = frameCanvas.getContext('2d', { willReadFrequently: true });

const selectMethod = document.getElementById('selectMethod');
const inputGradientThreshold = document.getElementById('inputGradientThreshold');
const inputExtensionFactor   = document.getElementById('inputExtensionFactor');

/* ===== Config (preserved from your calibration file) ===== */
const MIRROR_PREVIEW = true;           // mirror video ONLY
const CALIBRATION_SECONDS = 10;        // freeze overlay after 10s of valid calibration
const VERTICAL_SCALE = 1.0;            // vertical pitch relative to horizontal pitch
const MIN_SEP_PX = 80;                 // minimum F–J separation to accept calibration

/* Keyboard layout (unchanged, variable-width rows, bottom→top) */  // :contentReference[oaicite:1]{index=1}
const ROWS = [
  { offset:0, keys:[{label:'`',w:1},{label:'1',w:1},{label:'2',w:1},{label:'3',w:1},{label:'4',w:1},{label:'5',w:1},{label:'6',w:1},{label:'7',w:1},{label:'8',w:1},{label:'9',w:1},{label:'0',w:1},{label:'-',w:1},{label:'=',w:1},{label:'⌫',w:1.5}]},
  { offset:0, keys:[{label:'⇥',w:1.5},{label:'Q',w:1},{label:'W',w:1},{label:'E',w:1},{label:'R',w:1},{label:'T',w:1},{label:'Y',w:1},{label:'U',w:1},{label:'I',w:1},{label:'O',w:1},{label:'P',w:1},{label:'[',w:1},{label:']',w:1},{label:'\\',w:1}]},
  { offset:0, keys:[{label:'⇪',w:1.75},{label:'A',w:1},{label:'S',w:1},{label:'D',w:1},{label:'F',w:1},{label:'G',w:1},{label:'H',w:1},{label:'J',w:1},{label:'K',w:1},{label:'L',w:1},{label:';',w:1},{label:"'",w:1},{label:'↩',w:2.25}]},
  { offset:0, keys:[{label:'⇧',w:2.25},{label:'Z',w:1},{label:'X',w:1},{label:'C',w:1},{label:'V',w:1},{label:'B',w:1},{label:'N',w:1},{label:'M',w:1},{label:',',w:1},{label:'.',w:1},{label:'/',w:1},{label:'⇧',w:2.25}]},
  { offset:0, keys:[{label:'fn',w:1.2},{label:'⌃',w:1.25},{label:'⌥',w:1.5},{label:'⌘',w:1.75},{label:'Space',w:6.5},{label:'⌘',w:1.75},{label:'⌥',w:1.5},{label:'←',w:1},{label:'↑',w:1},{label:'↓',w:1},{label:'→',w:1}]},
];

/* ===== State ===== */
let stream = null;
let currentDeviceId = null;
let lastVideoTime = -1;

let fjCalib = null;    // {F:{x,y}, J:{x,y}}
let quad = null;       // {LB,RB,TR,TL}
let frozen = false;
let calibStartMs = null;

let handLandmarker = null;
let drawer = null;

// User-adjustable scales
let heightScale = 1.00;
let topShrink   = 0.65;

/* ===== Utilities (vector math, layout helpers) ===== */
const lerp=(a,b,t)=>a+(b-a)*t;
const vadd=(a,b)=>({x:a.x+b.x,y:a.y+b.y});
const vsub=(a,b)=>({x:a.x-b.x,y:a.y-b.y});
const vmul=(a,s)=>({x:a.x*s,y:a.y*s});
const vlen=a=>Math.hypot(a.x,a.y);
const vnorm=a=>{const L=vlen(a)||1; return {x:a.x/L,y:a.y/L};};
const vrot90=a=>({x:-a.y,y:a.x});
const vdot=(a,b)=>a.x*b.x+a.y*b.y;
const normalDown=dir=>{const n=vrot90(dir); return (vdot(n,{x:0,y:1})>=0)?n:vmul(n,-1);};

function rowTotalUnits(row){ return (row.offset||0)+row.keys.reduce((s,k)=>s+(k.w||1),0); }
function uCenterInRow(row, keyLabel){
  const total=rowTotalUnits(row); let cur=(row.offset||0);
  for(const k of row.keys){ const w=k.w||1; if(k.label===keyLabel) return (cur+w/2)/total; cur+=w; }
  return 0.5;
}
function findHomeRowIndex(){ for(let i=0;i<ROWS.length;i++){ const lbls=ROWS[i].keys.map(k=>k.label); if(lbls.includes('F')&&lbls.includes('J')) return i; } return Math.floor(ROWS.length/2); }
function mapRectToQuad(u,v,q){ const {LB,RB,TR,TL}=q; return { x: LB.x*(1-u)*(1-v)+RB.x*u*(1-v)+TR.x*u*v+TL.x*(1-u)*v, y: LB.y*(1-u)*(1-v)+RB.y*u*(1-v)+TR.y*u*v+TL.y*(1-u)*v }; }

/* ===== Calibration solve (unchanged core, lightly refactored) */  // :contentReference[oaicite:2]{index=2}
function computeQuadFromFJ(F, J){
  const sep = Math.hypot(J.x - F.x, J.y - F.y);
  if (sep < MIN_SEP_PX) return null;

  const dirTop = vnorm(vsub(J,F));
  const nDown  = normalDown(dirTop);

  const R = ROWS.length;
  const homeIdx = findHomeRowIndex();
  const homeRow = ROWS[homeIdx];

  const uF = uCenterInRow(homeRow, 'F');
  const uJ = uCenterInRow(homeRow, 'J');
  const deltaU = uJ - uF;

  const scaleBottom = 1 / topShrink;
  const vHome = (homeIdx + 0.5) / R;
  const tHome = 1 - vHome;
  const sHome = 1 + tHome * (scaleBottom - 1);

  const wTop = sep / (sHome * Math.max(1e-6, deltaU));

  const unitsHome = rowTotalUnits(homeRow);
  const oneUnitOnHome = (sHome * wTop) / unitsHome;
  const uy = oneUnitOnHome * VERTICAL_SCALE * heightScale;
  const totalH = R * uy;
  const dHome = totalH * tHome;

  const Ctop = vsub( vsub(F, vmul(nDown, dHome)), vmul(dirTop, (uF - 0.5) * wTop * sHome) );

  const TL = vsub(Ctop, vmul(dirTop, wTop/2));
  const TR = vadd(Ctop, vmul(dirTop, wTop/2));
  const LB = vadd( vadd( vmul(vsub(TL, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );
  const RB = vadd( vadd( vmul(vsub(TR, Ctop), scaleBottom), Ctop ), vmul(nDown, totalH) );

  return { LB, RB, TR, TL };
}

/* ===== Drawing helpers (from your file) ===== */  // :contentReference[oaicite:3]{index=3}
function drawPolygon(points){
  octx.beginPath();
  octx.moveTo(points[0].x, points[0].y);
  for(let i=1;i<points.length;i++){ const p=points[i]; if(!Number.isFinite(p.x)||!Number.isFinite(p.y)) return; octx.lineTo(p.x,p.y); }
  octx.closePath();
  octx.stroke();
}
function drawLabelAtCenter(points, text, fontPx){
  const cx=(points[0].x+points[1].x+points[2].x+points[3].x)/4;
  const cy=(points[0].y+points[1].y+points[2].y+points[3].y)/4;
  octx.font=`${Math.max(10,Math.round(fontPx))}px system-ui`; octx.textAlign='center'; octx.textBaseline='middle';
  octx.fillText(text, cx, cy);
}
function isSpecial(lblRaw){ const lbl=String(lblRaw).toLowerCase(); return new Set(['⇥','⇪','⇧','↩','⌫','space','fn','⌃','⌥','⌘','←','↑','↓','→']).has(lblRaw)||new Set(['space']).has(lbl); }
function drawKeyboard(q){
  if(!q) return;
  const R=ROWS.length;
  const homeRowIdx = ROWS.findIndex(r=>r.keys.some(k=>k.label==='F'));
  const vBandTop=(homeRowIdx+2/3)/R, vBandBot=(homeRowIdx+1/3)/R;
  const pTop=mapRectToQuad(0.5,vBandTop,q), pBot=mapRectToQuad(0.5,vBandBot,q);
  const keyH=Math.hypot(pTop.x-pBot.x,pTop.y-pBot.y), labelSize=keyH*0.45;

  for(let r=0;r<R;r++){
    const row=ROWS[r], vBot=r/R, vTop=(r+1)/R;
    const totalW=(row.offset||0)+row.keys.reduce((s,k)=>s+(k.w||1),0); let cur=(row.offset||0);
    for(const k of row.keys){
      const w=k.w||1, u0=cur/totalW, u1=(cur+w)/totalW;
      const p0=mapRectToQuad(u0,vTop,q), p1=mapRectToQuad(u1,vTop,q), p2=mapRectToQuad(u1,vBot,q), p3=mapRectToQuad(u0,vBot,q);
      const special=isSpecial(k.label);
      octx.lineWidth=special?2:1.25; octx.strokeStyle=special?'rgba(0,120,0,0.95)':'rgba(0,128,255,0.6)'; octx.fillStyle=special?'rgba(0,120,0,0.08)':'rgba(0,128,255,0.08)';
      drawPolygon([p0,p1,p2,p3]); octx.fill();
      octx.fillStyle='#0a0a0a'; drawLabelAtCenter([p0,p1,p2,p3], k.label, labelSize);
      if(k.label==='F'||k.label==='J'){ octx.strokeStyle='rgba(0,200,0,0.95)'; octx.lineWidth=2.25; drawPolygon([p0,p1,p2,p3]); }
      cur+=w;
    }
  }

  if(showDebugChk.checked && fjCalib){
    octx.strokeStyle='rgba(0,255,255,0.95)'; octx.lineWidth=2;
    const drawX=(pt,r=6)=>{ octx.beginPath(); octx.moveTo(pt.x-r,pt.y-r); octx.lineTo(pt.x+r,pt.y+r); octx.moveTo(pt.x+r,pt.y-r); octx.lineTo(pt.x-r,pt.y+r); octx.stroke(); };
    drawX(fjCalib.F); drawX(fjCalib.J);
  }
}
function drawPillLabel(text,x,y){
  octx.save(); octx.font='12px system-ui'; const padX=6,padY=3; const m=octx.measureText(text);
  const w=Math.ceil(m.width)+padX*2, h=16+(padY-3), r=8; const left=Math.round(x-w/2), top=Math.round(y-h);
  octx.beginPath(); octx.moveTo(left+r,top);
  octx.arcTo(left+w,top,left+w,top+h,r); octx.arcTo(left+w,top+h,left,top+h,r);
  octx.arcTo(left,top+h,left,top,r); octx.arcTo(left,top,left+w,top,r);
  octx.closePath(); octx.fillStyle='rgba(255,255,255,0.85)'; octx.fill(); octx.strokeStyle='rgba(0,0,0,0.25)'; octx.stroke();
  octx.fillStyle='#111'; octx.textAlign='center'; octx.textBaseline='middle'; octx.fillText(text,left+w/2,top+h/2); octx.restore();
}

/* ===== M5 gradient fingertip (integrated from your fingertip page) ===== */
const FINGER_TIPS  = [4,8,12,16,20];                        // thumb,index,middle,ring,pinky
const FINGER_BASES = {4:3, 8:7, 12:11, 16:15, 20:19};       // for projection/gradient
function rgbToHsl(r,g,b){ r/=255; g/=255; b/=255; const max=Math.max(r,g,b),min=Math.min(r,g,b); let h,s,l=(max+min)/2; if(max===min){h=s=0;}else{const d=max-min; s=l>0.5? d/(2-max-min): d/(max+min); switch(max){case r:h=(g-b)/d+(g<b?6:0);break;case g:h=(b-r)/d+2;break;case b:h=(r-g)/d+4;break;} h/=6;} return [h*360,s,l];}
function colorDiff(r1,g1,b1,r2,g2,b2){ const dr=(r1-r2)/255,dg=(g1-g2)/255,db=(b1-b2)/255; const rgbDist=Math.sqrt(dr*dr+dg*dg+db*db);
  const [h1,s1,l1]=rgbToHsl(r1,g1,b1), [h2,s2,l2]=rgbToHsl(r2,g2,b2); let dh=Math.abs(h1-h2); if(dh>180) dh=360-dh; dh/=180;
  const ds=Math.abs(s1-s2), dl=Math.abs(l1-l2); return (rgbDist*0.5 + dh*0.25 + ds*0.125 + dl*0.125)*255; }

function updateFrameBufferUnmirrored(){
  const w=video.videoWidth, h=video.videoHeight;
  if(!w||!h) return;
  frameCanvas.width=w; frameCanvas.height=h;
  // draw UNMIRRORED for pixel reads in screen space
  fctx.setTransform(1,0,0,1,0,0);
  fctx.drawImage(video, 0, 0, w, h);
}

function buildROI(landmarks, tipIndex, baseIndex){
  const w=overlay.width, h=overlay.height;
  const tip=landmarks[tipIndex], base=landmarks[baseIndex];
  if(!tip||!base) return null;
  let tipX=tip.x*w, tipY=tip.y*h, baseX=base.x*w, baseY=base.y*h;
  if(MIRROR_PREVIEW){ tipX=w-tipX; baseX=w-baseX; } // convert to overlay (non-mirrored) coords
  const vx=tipX-baseX, vy=tipY-baseY, len=Math.hypot(vx,vy)||1;
  const ux=vx/len, uy=vy/len;
  const EXT = parseFloat(inputExtensionFactor.value)||3.5;
  return { tipX, tipY, projX: tipX + ux*len*EXT, projY: tipY + uy*len*EXT, ux, uy };
}

const M5_MAX_SEARCH_DIST=60, M5_LOOKAHEAD=5, M5_MIN_SUCCESS_DIST=5;
function findGradientTip(roi){
  const GRAD=parseInt(inputGradientThreshold.value,10)||30;
  const vw=frameCanvas.width, vh=frameCanvas.height;
  const data=fctx.getImageData(0,0,vw,vh).data;
  let final=null;
  for(let d=1; d<M5_MAX_SEARCH_DIST; d++){
    const x=Math.round(roi.tipX + roi.ux*d);
    const y=Math.round(roi.tipY + roi.uy*d);
    const x2=Math.round(roi.tipX + roi.ux*(d+M5_LOOKAHEAD));
    const y2=Math.round(roi.tipY + roi.uy*(d+M5_LOOKAHEAD));
    if(x<0||x>=vw||y<0||y>=vh||x2<0||x2>=vw||y2<0||y2>=vh) break;
    const i1=(y*vw+x)*4, i2=(y2*vw+x2)*4;
    const diff=colorDiff(data[i1],data[i1+1],data[i1+2], data[i2],data[i2+1],data[i2+2]);
    if(diff>GRAD && d>M5_MIN_SUCCESS_DIST){ final={x,y, source:'M5'}; break; }
  }
  return final ?? { x: roi.projX, y: roi.projY, source:'M2' };
}

/* Fingertips → key labels (now using selected method) */
function buildKeyCells(q){
  if(!q) return [];
  const cells=[]; const R=ROWS.length;
  for(let r=0;r<R;r++){
    const row=ROWS[r], vBot=r/R, vTop=(r+1)/R;
    const totalW=(row.offset||0)+row.keys.reduce((s,k)=>s+(k.w||1),0); let cur=(row.offset||0);
    for(const k of row.keys){
      const w=k.w||1, u0=cur/totalW, u1=(cur+w)/totalW;
      const p0=mapRectToQuad(u0,vTop,q), p1=mapRectToQuad(u1,vTop,q), p2=mapRectToQuad(u1,vBot,q), p3=mapRectToQuad(u0,vBot,q);
      cells.push({ label:k.label, poly:[p0,p1,p2,p3] }); cur+=w;
    }
  }
  return cells;
}
function pointInConvexPolygon(pt, poly){
  let pos=false, neg=false;
  for(let i=0;i<poly.length;i++){
    const a=poly[i], b=poly[(i+1)%poly.length];
    const cross=(b.x-a.x)*(pt.y-a.y)-(b.y-a.y)*(pt.x-a.x);
    if(cross<0) neg=true; if(cross>0) pos=true; if(pos&&neg) return false;
  }
  return true;
}
function findKeyAtPoint(cells, pt){ for(const c of cells){ if(pointInConvexPolygon(pt,c.poly)) return c; } return null; }

/* Compute fingertip points (method switcher) */
function fingertipsByMethod(result){
  const tips=[];
  if(!result?.landmarks?.length) return tips;
  const W=overlay.width, H=overlay.height;
  const method=selectMethod.value;

  for(const hand of result.landmarks){
    for(const tipIdx of FINGER_TIPS){
      let pt=null, tag='';
      if(method==='LANDMARK_TIP'){                 // M1
        const lm=hand[tipIdx]; let x=lm.x*W, y=lm.y*H; if(MIRROR_PREVIEW) x=W-x;
        pt={x,y,source:'M1'};
      } else {
        // Build ROI from base→tip and either project (M2) or gradient (M5)
        const baseIdx=FINGER_BASES[tipIdx];
        const roi=buildROI(hand, tipIdx, baseIdx); if(!roi) continue;
        if(method==='PROJECTION'){ pt={x:roi.projX, y:roi.projY, source:'M2'}; }
        else { pt=findGradientTip(roi); }          // M5
      }
      tips.push(pt);
    }
  }
  return tips;
}

/* Hit-test and draw labels for fingertips */
function drawFingerKeyLabels(result,q){
  if(!q||!result) return;
  const cells=buildKeyCells(q); if(!cells.length) return;
  const tips=fingertipsByMethod(result);
  for(const t of tips){
    const hit=findKeyAtPoint(cells,{x:t.x,y:t.y});
    const label=hit? `${hit.label}` : '—';
    drawPillLabel(`${t.source}: ${label}`, t.x, t.y-12);
    // (Hook here: when stabilized, convert label→event to your text engine)
  }
}

/* ===== MediaPipe Hands ===== */  // :contentReference[oaicite:4]{index=4}
const vision = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm");
handLandmarker = await HandLandmarker.createFromOptions(vision, {
  baseOptions: { modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task", delegate: "GPU" },
  runningMode: "VIDEO", numHands: 2, minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5
});
drawer = new DrawingUtils(octx);

/* ===== Camera & UI ===== */
async function listCameras(){
  const devices=await navigator.mediaDevices.enumerateDevices();
  const cams=devices.filter(d=>d.kind==='videoinput');
  camSel.innerHTML=''; cams.forEach((d,i)=>{ const opt=document.createElement('option'); opt.value=d.deviceId; opt.textContent=d.label||`Camera ${i+1}`; camSel.appendChild(opt); });
  if(currentDeviceId) camSel.value=currentDeviceId;
}
function stopStream(){ if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; } stopBtn.disabled=true; }
function resizeOverlayToVideo(){ const w=video.videoWidth, h=video.videoHeight; if(!w||!h) return; overlay.width=w; overlay.height=h; }
async function startStream(constraints){
  try{
    stopStream(); stream=await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject=stream; await video.play(); stopBtn.disabled=false; await listCameras();
    video.style.transform=MIRROR_PREVIEW?'scaleX(-1)':'none'; overlay.style.transform='none';
    resizeOverlayToVideo(); updateBlackMode(); startCalibration();
  }catch(err){ alert('Camera error: '+(err?.message||err)); console.error(err); }
}
async function captureJpegFromVideo(video,{quality=0.92}={}){
  const w=video.videoWidth, h=video.videoHeight;
  frameCanvas.width=w; frameCanvas.height=h;
  // snapshot like the preview (mirrored)
  fctx.setTransform(MIRROR_PREVIEW?-1:1,0,0,1,MIRROR_PREVIEW?w:0,0);
  fctx.drawImage(video,0,0,w,h);
  const blob=await new Promise(res=>frameCanvas.toBlob(res,'image/jpeg',quality)); return blob;
}
async function downloadSnapshot(){
  const blob=await captureJpegFromVideo(video,{quality:0.92});
  const url=URL.createObjectURL(blob); const a=document.createElement('a'); const ts=new Date().toISOString().replace(/[:.]/g,'-');
  a.href=url; a.download=`frame-${ts}.jpg`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

/* ===== Calibration & loop ===== */
function updateBlackMode(){ overlay.style.background=blackChk.checked?'#000':'transparent'; }
function startCalibration(){ frozen=false; calibStartMs=null; fjCalib=null; quad=null; statusEl.textContent='Calibrating…'; }
function clearOverlay(){ octx.clearRect(0,0,overlay.width,overlay.height); }

function pickFJFromResult(result){
  if(!result?.landmarks?.length) return null;
  const W=overlay.width,H=overlay.height;
  // use INDEX fingertips (landmark 8) for F/J sampling (consistent with your file)
  const tips=result.landmarks.map(hand=>{ const t=hand[8]; let x=t.x*W,y=t.y*H; if(MIRROR_PREVIEW) x=W-x; return {x,y}; });
  let left=0,right=tips.length-1;
  if(tips.length>=2){
    const order=[...tips.keys()].sort((a,b)=>tips[a].x-tips[b].x);
    left=order[0]; right=order[order.length-1];
  }
  return {F: tips[left], J: tips[right]};
}

function updateCalibration(result, nowMs){
  const fj=pickFJFromResult(result);
  if(!fj){ statusEl.textContent='Need both hands on F/J…'; return; }
  if(!frozen){
    fjCalib=fj; const q=computeQuadFromFJ(fjCalib.F,fjCalib.J);
    if(q){ quad=q; if(calibStartMs===null) calibStartMs=nowMs;
      const elapsed=(nowMs-calibStartMs)/1000, left=Math.max(0,CALIBRATION_SECONDS-elapsed);
      if(elapsed>=CALIBRATION_SECONDS){ frozen=true; statusEl.textContent='Frozen'; }
      else statusEl.textContent=`Calibrating… ${left.toFixed(1)}s`;
    } else statusEl.textContent='Calibrating…';
  } else statusEl.textContent='Frozen';
}

function drawHands(result){
  if(!result||!showHandsChk.checked) return;
  const {landmarks}=result; if(!landmarks) return;
  octx.save(); if(MIRROR_PREVIEW){ octx.translate(overlay.width,0); octx.scale(-1,1); }
  for(const hand of landmarks){ drawer.drawConnectors(hand, HandLandmarker.HAND_CONNECTIONS, { lineWidth:2 }); drawer.drawLandmarks(hand,{ radius:2.5 }); }
  octx.restore();
}

function pump(){
  if(!stream){ requestAnimationFrame(pump); return; }
  const w=video.videoWidth,h=video.videoHeight;
  if(w&&h){
    if(overlay.width!==w||overlay.height!==h) resizeOverlayToVideo();
    if(liveChk.checked){
      const nowMs=performance.now(); const vt=video.currentTime;
      if(vt!==lastVideoTime){
        try{
          updateFrameBufferUnmirrored();                       // buffer for M5
          const result=handLandmarker.detectForVideo(video, nowMs);
          clearOverlay(); drawHands(result);
          if(!frozen) updateCalibration(result, nowMs);
          drawKeyboard(quad);
          drawFingerKeyLabels(result, quad);
          lastVideoTime=vt;
        }catch(e){ console.error('detect/draw error',e); statusEl.textContent='⚠️ detection error (see console)'; }
      }
    } else clearOverlay();
  } else clearOverlay();
  requestAnimationFrame(pump);
}

/* ===== Wire up UI ===== */
async function startStreamWith(constraints){ await startStream(constraints); }

startBtn.addEventListener('click', async ()=>{
  await startStreamWith({ video:{ facingMode:{ideal:'environment'}, width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30,max:60} }, audio:false });
});
camSel.addEventListener('change', async ()=>{ currentDeviceId=camSel.value; await startStreamWith({ video:{ deviceId:{exact:currentDeviceId} }, audio:false }); });
stopBtn.addEventListener('click', ()=>{ stopStream(); clearOverlay(); });
snapBtn.addEventListener('click', downloadSnapshot);
blackChk.addEventListener('change', updateBlackMode);
recalBtn.addEventListener('click', ()=> startCalibration());

// Height & ratio sliders
function setHeightScale(s){ const v=Math.max(0.3,Math.min(3.0,Number(s)||1.0)); heightScale=v; heightVal.textContent=`${Math.round(v*100)}%`; if(fjCalib) quad=computeQuadFromFJ(fjCalib.F,fjCalib.J); }
function setTopShrink(s){ const v=Math.max(0.3,Math.min(1.5,Number(s)||0.65)); topShrink=v; ratioVal.textContent=v.toFixed(2); if(fjCalib) quad=computeQuadFromFJ(fjCalib.F,fjCalib.J); }
if(heightSlider){ setHeightScale(heightSlider.value); heightSlider.addEventListener('input',e=>setHeightScale(e.target.value)); }
if(ratioSlider){ setTopShrink(ratioSlider.value); ratioSlider.addEventListener('input',e=>setTopShrink(e.target.value)); }
heightDefaultBtn.addEventListener('click', ()=>{ heightSlider.value='1.00'; setHeightScale('1.00'); });
ratioDefaultBtn.addEventListener('click', ()=>{ ratioSlider.value='0.65'; setTopShrink('0.65'); });

video.addEventListener('playing', ()=> requestAnimationFrame(pump));
window.addEventListener('resize', resizeOverlayToVideo);
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden'){ stopStream(); clearOverlay(); }});
window.addEventListener('pagehide', ()=>{ stopStream(); clearOverlay(); });
