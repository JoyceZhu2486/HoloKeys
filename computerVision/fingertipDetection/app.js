import {
    HandLandmarker,
    FilesetResolver,
    DrawingUtils
  } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest";
  
  const stageWrap = document.getElementById("stageWrap");
  const stage     = document.getElementById("stage");
  const video     = document.getElementById("video");
  const overlay   = document.getElementById("overlay");
  const octx      = overlay.getContext("2d");
  const raw       = document.getElementById("raw");
  const rctx      = raw.getContext("2d");
  const statusEl  = document.getElementById("status");
  const btnStart  = document.getElementById("btnStart");
  const chkLive   = document.getElementById("chkLive");
  const btnDetectAndSave = document.getElementById("btnDetectAndSave");
  const toolbar   = document.getElementById("toolbar");
  
  const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
  
  let filesetResolver = null;
  let handLandmarker  = null;
  let drawer          = null;
  let cvReady         = false;
  
  // ---- Wait for OpenCV.js to be ready ----
  function waitForOpenCVReady() {
    return new Promise((resolve) => {
      // If cv is already initialized
      if (window.cv && cv.Mat) { cvReady = true; return resolve(); }
      // Otherwise wait for runtime
      const check = () => {
        if (window.cv && cv.Mat) { cvReady = true; resolve(); }
        else setTimeout(check, 30);
      };
      check();
    });
  }
  
  // ---- Size & layout ----
  function setExactStageSize(w, h) {
    stage.style.width = w + "px";   stage.style.height = h + "px";
    video.style.width = w + "px";   video.style.height = h + "px";
    overlay.style.width = w + "px"; overlay.style.height = h + "px";
    raw.style.width = w + "px";     raw.style.height = h + "px";
  
    overlay.width = w; overlay.height = h; // canvas buffer
    raw.width = w; raw.height = h;
  
    stageWrap.style.width = w + "px";
    stageWrap.style.height = h + "px";
  }
  
  function ensureSizedToVideo() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return false;
    const sized =
      parseInt(stage.style.width) === vw &&
      parseInt(stage.style.height) === vh &&
      overlay.width === vw && overlay.height === vh &&
      raw.width === vw && raw.height === vh;
    if (!sized) setExactStageSize(vw, vh);
    return true;
  }
  
  function fitStageToScreen() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const toolbarRect = toolbar.getBoundingClientRect();
    const availableW = document.documentElement.clientWidth - 20;
    const availableH = document.documentElement.clientHeight - (toolbarRect.height + 28);
    const scale = Math.min(1, availableW / vw, availableH / vh);
    stageWrap.style.transform = `scale(${scale})`;
  }
  
  function clearOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }
  
  // ---- Math helpers ----
  function toPx(lm) {
    return { x: lm.x * overlay.width, y: lm.y * overlay.height };
  }
  function sub(a,b){ return { x:a.x-b.x, y:a.y-b.y }; }
  function norm(v){ const d=Math.hypot(v.x,v.y)||1e-6; return { x:v.x/d, y:v.y/d }; }
  function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }
  const TIP_IDX = [4,8,12,16,20], PIP_IDX=[3,7,11,15,19];
  
  // ---- Build a binary hand mask using convex hull of landmarks (for all hands) ----
  // Returns cv.Mat (CV_8UC1) sized to frame with 0/255 values
  function buildHandMask(frameW, frameH, handsLandmarks) {
    const mask = new cv.Mat.zeros(frameH, frameW, cv.CV_8UC1);
  
    for (const hand of handsLandmarks) {
      // Collect 2D pixel points
      const pts = [];
      for (const lm of hand) {
        pts.push(new cv.Point(Math.round(lm.x * frameW), Math.round(lm.y * frameH)));
      }
  
      // Compute convex hull (by landmarks indices)
      const ptsMat = cv.matFromArray(pts.length, 1, cv.CV_32SC2, pts.flatMap(p => [p.x, p.y]));
      const hullIdx = new cv.Mat();
      cv.convexHull(ptsMat, hullIdx, true, false); // return indices
  
      // Build hull point list
      const hullPts = [];
      for (let i = 0; i < hullIdx.rows; i++) {
        const idx = hullIdx.intPtr(i,0)[0];
        hullPts.push(pts[idx]);
      }
  
      // Fill the hull polygon
      const hullMat = cv.matFromArray(hullPts.length, 1, cv.CV_32SC2, hullPts.flatMap(p => [p.x, p.y]));
      cv.fillConvexPoly(mask, hullMat, new cv.Scalar(255));
  
      // Optional: small dilation to be tolerant to tiny landmark jitters
      const kernel = cv.Mat.ones(3,3,cv.CV_8UC1);
      cv.dilate(mask, mask, kernel);
      kernel.delete(); ptsMat.delete(); hullIdx.delete(); hullMat.delete();
    }
    return mask;
  }
  
  // ---- Refine fingertip by searching outward along the finger axis until leaving mask ----
  function refineTipAxisSearch(tipPx, pipPx, maskMat) {
    const v = norm(sub(tipPx, pipPx));               // outward direction
    const fingerLen = Math.hypot(tipPx.x - pipPx.x, tipPx.y - pipPx.y);
    const maxOut = clamp(fingerLen * 0.7, 10, 90);   // search budget (px)
    let lastInside = { x: Math.round(tipPx.x), y: Math.round(tipPx.y) };
  
    for (let t = 0; t <= maxOut; t += 1) {
      const x = Math.round(tipPx.x + v.x * t);
      const y = Math.round(tipPx.y + v.y * t);
      if (x < 0 || y < 0 || x >= maskMat.cols || y >= maskMat.rows) break;
      const inside = maskMat.ucharPtr(y, x)[0] > 0;
      if (inside) lastInside = { x, y };
      else break; // first outside => stop
    }
    return lastInside;
  }
  
  // ---- Draw hands and refined tips ----
  function drawResultsWithRefinedTips(result, refinedTipsByHand) {
    clearOverlay();
    if (!result?.landmarks?.length) return;
  
    for (let i=0; i<result.landmarks.length; i++) {
      const hand = result.landmarks[i];
      // Skeleton/landmarks
      drawer.drawConnectors(hand, HandLandmarker.HAND_CONNECTIONS, { lineWidth: 2 });
      drawer.drawLandmarks(hand, { radius: 3 });
  
      // Refined tips
      const tips = refinedTipsByHand[i];
      if (tips) {
        octx.save();
        octx.fillStyle = "#00ff00";
        for (const pt of tips) {
          octx.beginPath();
          octx.arc(pt.x, pt.y, 3, 0, Math.PI*2);
          octx.fill();
        }
        octx.restore();
      }
    }
  }
  
  // ---- One-frame detection + refinement pipeline ----
  function detectAndRefineOnce() {
    if (!handLandmarker || !cvReady || video.readyState < 2) return null;
  
    // Ensure sizes
    ensureSizedToVideo();
  
    // Run detection
    const now = performance.now();
    const result = handLandmarker.detectForVideo(video, now);
  
    if (!result?.landmarks?.length) {
      clearOverlay();
      return { result, refinedTips: [] };
    }
  
    // Grab current frame RGBA into raw canvas, then into cv.Mat
    rctx.drawImage(video, 0, 0, raw.width, raw.height);
    const imageData = rctx.getImageData(0, 0, raw.width, raw.height);
    const frameRGBA = cv.matFromImageData(imageData);
  
    // Build binary mask via convex hull of landmarks
    const handMask = buildHandMask(frameRGBA.cols, frameRGBA.rows, result.landmarks);
  
    // Refine tips for each hand
    const refinedTipsByHand = [];
    for (const hand of result.landmarks) {
      const tips = [];
      for (let f=0; f<5; f++) {
        const tipPx = toPx(hand[TIP_IDX[f]]);
        const pipPx = toPx(hand[PIP_IDX[f]]);
        const refined = refineTipAxisSearch(tipPx, pipPx, handMask);
        tips.push(refined);
      }
      refinedTipsByHand.push(tips);
    }
  
    // Draw skeleton + refined tips
    drawResultsWithRefinedTips(result, refinedTipsByHand);
  
    // Cleanup cv mats
    frameRGBA.delete();
    handMask.delete();
  
    return { result, refinedTips: refinedTipsByHand };
  }
  
  // ---- Camera ----
  async function startCamera() {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    video.srcObject = stream;
    await video.play();
    await new Promise(r => {
      if (video.readyState >= 2 && video.videoWidth) return r();
      video.onloadeddata = () => r();
    });
    ensureSizedToVideo();
    fitStageToScreen();
    btnDetectAndSave.disabled = false;
    statusEl.textContent = "Camera ready";
  }
  
  // ---- Live loop ----
  let rafId = null;
  function startLive() {
    if (rafId) return;
    statusEl.textContent = "Live…";
    const loop = () => {
      if (!chkLive.checked) { rafId = null; statusEl.textContent = "Camera ready"; return; }
      detectAndRefineOnce(); // draws overlay internally
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }
  
  // ---- Detect & Save (composite native video + overlay) ----
  function detectOnceAndSave() {
    const out = detectAndRefineOnce();
    // Composite at native resolution
    const w = overlay.width, h = overlay.height;
    const temp = document.createElement("canvas");
    temp.width = w; temp.height = h;
    const tctx = temp.getContext("2d");
    tctx.drawImage(video, 0, 0, w, h);
    tctx.drawImage(overlay, 0, 0);
  
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const url = temp.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `method3_refined_${ts}.png`;
    a.click();
  }
  
  // ---- Model init ----
  async function initModel() {
    statusEl.textContent = "Loading model…";
    const wasmBase = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
    filesetResolver = await FilesetResolver.forVisionTasks(wasmBase);
    handLandmarker = await HandLandmarker.createFromOptions(filesetResolver, {
      baseOptions: { modelAssetPath: MODEL_URL },
      numHands: 2,
      runningMode: "VIDEO",
    });
    drawer = new DrawingUtils(octx);
    statusEl.textContent = "Model ready";
  }
  
  // ---- UI wiring ----
  btnStart.addEventListener("click", async () => {
    btnStart.disabled = true;
    try {
      await Promise.all([waitForOpenCVReady(), initModel(), startCamera()]);
    } catch (e) {
      console.error(e);
      statusEl.textContent = "Error starting";
      btnStart.disabled = false;
      return;
    }
    statusEl.textContent = "Ready";
  });
  
  chkLive.addEventListener("change", () => {
    if (!handLandmarker || !video.srcObject || !cvReady) {
      chkLive.checked = false;
      return;
    }
    if (chkLive.checked) startLive();
    else if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
      statusEl.textContent = "Camera ready";
    }
  });
  
  btnDetectAndSave.addEventListener("click", () => {
    if (!cvReady) return;
    detectOnceAndSave();
  });
  
  // Keep scaled to fit screen
  window.addEventListener("resize", fitStageToScreen);
  video.addEventListener("resize", () => { ensureSizedToVideo(); fitStageToScreen(); });
  