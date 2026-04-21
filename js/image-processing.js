import { resamplePolyline } from "./fourier-utils.js";

const MAX_DIM = 512;

// ─── Public API ──────────────────────────────────────────

export async function extractContourFromRaster(file, sampleCount) {
  const { gray, width, height } = await loadAndPrepare(file);
  const blurred = gaussianBlur(gray, width, height);
  const { magnitude, direction } = sobel(blurred, width, height);
  const thinned = nonMaxSuppression(magnitude, direction, width, height);
  const { high, low } = computeThresholds(magnitude, width, height);
  const edges = cannyHysteresis(thinned, width, height, high, low);
  const rawContours = traceContours(edges, width, height);

  if (!rawContours.length) {
    throw new Error("No edges detected. Try an image with clearer outlines.");
  }

  rawContours.sort((a, b) => b.length - a.length);
  const minLen = Math.max(8, rawContours[0].length * 0.03);
  const significant = rawContours.filter((c) => c.length >= minLen).slice(0, 128);

  const bridged = bridgeChains(significant);
  const resampled = resamplePolyline(bridged, sampleCount, true);

  if (!resampled.length) {
    throw new Error("Could not extract contour from image.");
  }

  return { points: resampled, isClosed: true };
}

// ─── Image loading ───────────────────────────────────────

function loadImg(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image."));
    img.src = url;
  });
}

async function loadAndPrepare(file) {
  const url = URL.createObjectURL(file);
  let img;
  try {
    img = await loadImg(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const scale = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");

  // White background so transparent PNGs get composited properly
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }

  return { gray, width, height };
}

// ─── Gaussian blur (5×5, σ ≈ 1.0) ───────────────────────

function gaussianBlur(src, width, height) {
  const kernel = [
    1, 4, 7, 4, 1, 4, 16, 26, 16, 4, 7, 26, 41, 26, 7, 4, 16, 26, 16, 4, 1, 4, 7, 4, 1,
  ];
  const kSize = 5;
  const kHalf = 2;
  const kSum = 273;
  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let ky = 0; ky < kSize; ky++) {
        const py = Math.min(height - 1, Math.max(0, y + ky - kHalf));
        for (let kx = 0; kx < kSize; kx++) {
          const px = Math.min(width - 1, Math.max(0, x + kx - kHalf));
          sum += src[py * width + px] * kernel[ky * kSize + kx];
        }
      }
      out[y * width + x] = sum / kSum;
    }
  }

  return out;
}

// ─── Sobel operator ──────────────────────────────────────

function sobel(src, width, height) {
  const magnitude = new Float32Array(width * height);
  const direction = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const tl = src[(y - 1) * width + (x - 1)];
      const tc = src[(y - 1) * width + x];
      const tr = src[(y - 1) * width + (x + 1)];
      const ml = src[y * width + (x - 1)];
      const mr = src[y * width + (x + 1)];
      const bl = src[(y + 1) * width + (x - 1)];
      const bc = src[(y + 1) * width + x];
      const br = src[(y + 1) * width + (x + 1)];

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;

      magnitude[y * width + x] = Math.hypot(gx, gy);
      direction[y * width + x] = Math.atan2(gy, gx);
    }
  }

  return { magnitude, direction };
}

// ─── Non-maximum suppression (thin edges to 1 px) ───────

function nonMaxSuppression(mag, dir, width, height) {
  const out = new Float32Array(width * height);

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const m = mag[idx];
      if (m === 0) continue;

      let angle = (dir[idx] * 180) / Math.PI;
      if (angle < 0) angle += 180;

      let n1, n2;
      if (angle < 22.5 || angle >= 157.5) {
        n1 = mag[idx - 1];
        n2 = mag[idx + 1];
      } else if (angle < 67.5) {
        n1 = mag[(y - 1) * width + (x + 1)];
        n2 = mag[(y + 1) * width + (x - 1)];
      } else if (angle < 112.5) {
        n1 = mag[(y - 1) * width + x];
        n2 = mag[(y + 1) * width + x];
      } else {
        n1 = mag[(y - 1) * width + (x - 1)];
        n2 = mag[(y + 1) * width + (x + 1)];
      }

      out[idx] = m >= n1 && m >= n2 ? m : 0;
    }
  }

  return out;
}

// ─── Auto thresholds (75th-percentile heuristic) ────────

function computeThresholds(magnitude, width, height) {
  const vals = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const v = magnitude[y * width + x];
      if (v > 0) vals.push(v);
    }
  }
  if (!vals.length) return { high: 1, low: 0.5 };

  vals.sort((a, b) => a - b);
  const high = Math.max(vals[Math.floor(vals.length * 0.75)], 1);
  const low = high * 0.35;
  return { high, low };
}

// ─── Hysteresis thresholding (BFS flood-fill) ───────────

function cannyHysteresis(thinned, width, height, high, low) {
  const STRONG = 255;
  const out = new Uint8Array(width * height);

  const queue = [];
  for (let i = 0; i < width * height; i++) {
    if (thinned[i] >= high) {
      out[i] = STRONG;
      queue.push(i);
    }
  }

  const ndx = [-1, 0, 1, -1, 1, -1, 0, 1];
  const ndy = [-1, -1, -1, 0, 0, 1, 1, 1];

  while (queue.length) {
    const idx = queue.shift();
    const x = idx % width;
    const y = (idx - x) / width;

    for (let d = 0; d < 8; d++) {
      const nx = x + ndx[d];
      const ny = y + ndy[d];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nIdx = ny * width + nx;
      if (out[nIdx] === 0 && thinned[nIdx] >= low) {
        out[nIdx] = STRONG;
        queue.push(nIdx);
      }
    }
  }

  return out;
}

// ─── Contour tracing (8-connected chain following) ──────

function traceContours(edges, width, height) {
  const visited = new Uint8Array(width * height);
  const contours = [];

  const ndx = [1, 1, 0, -1, -1, -1, 0, 1];
  const ndy = [0, 1, 1, 1, 0, -1, -1, -1];

  for (let startY = 0; startY < height; startY++) {
    for (let startX = 0; startX < width; startX++) {
      const sIdx = startY * width + startX;
      if (!edges[sIdx] || visited[sIdx]) continue;

      const chain = [];
      let cx = startX;
      let cy = startY;

      while (true) {
        const cIdx = cy * width + cx;
        if (visited[cIdx]) break;
        visited[cIdx] = 1;
        chain.push({ x: cx, y: cy });

        let found = false;
        for (let d = 0; d < 8; d++) {
          const nx = cx + ndx[d];
          const ny = cy + ndy[d];
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          if (edges[ny * width + nx] && !visited[ny * width + nx]) {
            cx = nx;
            cy = ny;
            found = true;
            break;
          }
        }
        if (!found) break;
      }

      if (chain.length >= 5) {
        contours.push(chain);
      }
    }
  }

  return contours;
}

// ─── Bridge multiple chains into one continuous path ────

function bridgeChains(chains) {
  if (!chains.length) return [];
  if (chains.length === 1) return chains[0];

  const arrays = chains.map((c) => [...c]);
  const used = new Array(arrays.length).fill(false);
  used[0] = true;
  const order = [0];

  for (let step = 1; step < arrays.length; step++) {
    const last = arrays[order[order.length - 1]];
    const exit = last[last.length - 1];

    let bestIdx = -1;
    let bestDist = Infinity;
    let reverse = false;

    for (let i = 0; i < arrays.length; i++) {
      if (used[i]) continue;
      const ds = Math.hypot(arrays[i][0].x - exit.x, arrays[i][0].y - exit.y);
      const de = Math.hypot(
        arrays[i][arrays[i].length - 1].x - exit.x,
        arrays[i][arrays[i].length - 1].y - exit.y,
      );
      const d = Math.min(ds, de);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
        reverse = de < ds;
      }
    }

    if (bestIdx < 0) break;
    if (reverse) arrays[bestIdx].reverse();
    used[bestIdx] = true;
    order.push(bestIdx);
  }

  const result = [];
  for (const idx of order) {
    result.push(...arrays[idx]);
  }
  return result;
}
