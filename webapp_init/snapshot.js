// snapshot.js (ES module)

// Capture current frame → JPEG Blob. Optionally un-mirror saved file.
export async function captureJpegFromVideo(video, {
  width,
  height,
  quality = 0.92,
  unmirror = false
} = {}) {
  const w = width  ?? video.videoWidth;
  const h = height ?? video.videoHeight;

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (unmirror) {
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
  } else {
    ctx.drawImage(video, 0, 0, w, h);
  }

  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  return blob; // Blob type 'image/jpeg'
}

// Convenience: capture and trigger a download
export async function downloadSnapshot(video, opts = {}) {
  const blob = await captureJpegFromVideo(video, opts);
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
