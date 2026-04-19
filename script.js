const canvas = document.getElementById("fourier-canvas");
const context = canvas.getContext("2d");

const body = document.body;
const themeToggle = document.getElementById("theme-toggle");
const sourceModeInputs = document.querySelectorAll('input[name="source-mode"]');
const svgFileInput = document.getElementById("svg-file");
const sampleStarButton = document.getElementById("sample-star-btn");
const acceptDrawButton = document.getElementById("accept-draw-btn");
const clearDrawButton = document.getElementById("clear-draw-btn");
const termsRange = document.getElementById("terms-range");
const termsValue = document.getElementById("terms-value");
const speedRange = document.getElementById("speed-range");
const speedValue = document.getElementById("speed-value");
const pauseButton = document.getElementById("pause-btn");
const resetTraceButton = document.getElementById("reset-trace-btn");
const statusOutput = document.getElementById("status");

const SAMPLE_COUNT = 900;
const MAX_SVG_SIZE_BYTES = 2 * 1024 * 1024;
const STORAGE_THEME_KEY = "fourier-theme";
const TRAIL_RATIO = 0.9;
const MIN_TRAIL_POINT_LIMIT = 24;
const SPEED_UI_MIN = 1;
const SPEED_UI_MAX = 10;
const SPEED_INTERNAL_MIN = 0.02;
const SPEED_INTERNAL_MAX = 0.5;
const EDGE_BASE_GAP = 12;
const EDGE_EXTRA_GAP = 26;
const MIN_TOP_MARGIN = 56;
const MIN_LEFT_MARGIN = 56;
const MAX_TOP_MARGIN_RATIO = 0.42;
const MAX_LEFT_MARGIN_RATIO = 0.34;
const FRAME_PADDING = 18;
const DRAW_SCALE_FACTOR = 0.4;

const STAR_SVG = `
  <svg viewBox="0 0 1000 1000" xmlns="http://www.w3.org/2000/svg">
    <polygon points="500,90 618,360 910,360 674,528 765,820 500,650 235,820 326,528 90,360 382,360" />
  </svg>
`;

let WIDTH = 0;
let HEIGHT = 0;
let TOP_MARGIN = 0;
let LEFT_MARGIN = 0;
let DRAW_WIDTH = 0;
let DRAW_HEIGHT = 0;
let DRAW_ORIGIN = { x: 0, y: 0 };
let DRAW_CENTER = { x: 0, y: 0 };
let TOP_CENTER_Y = 0;
let LEFT_CENTER_X = 0;
let DRAW_SCALE = 1;

let sourceMode = "upload";
let normalizedPoints = [];
let xSeries = [];
let ySeries = [];
let trace = [];
let visibleTerms = Number(termsRange.value);
let speed = mapUiSpeedToInternal(Number(speedRange.value));
let isPaused = false;

let phase = 0;
let lastTimestamp = 0;

let isDrawing = false;
let drawPoints = [];
let drawPreviewPoints = [];
let pendingDrawSampledPoints = [];
let drawSoftColor = "rgba(255, 255, 255, 0.2)";
let drawMidColor = "rgba(255, 255, 255, 0.65)";
let drawGuideColor = "rgba(255, 255, 255, 0.35)";
let drawLineColor = "#ffffff";

function setStatus(message) {
  statusOutput.textContent = message;
}

function mapUiSpeedToInternal(uiValue) {
  const clamped = Math.min(SPEED_UI_MAX, Math.max(SPEED_UI_MIN, uiValue));
  const ratio = (clamped - SPEED_UI_MIN) / (SPEED_UI_MAX - SPEED_UI_MIN);
  return SPEED_INTERNAL_MIN + ratio * (SPEED_INTERNAL_MAX - SPEED_INTERNAL_MIN);
}

function getDominantRadius(series, limit = visibleTerms) {
  if (!series.length) {
    return 0.58;
  }

  const terms = series.slice(0, Math.max(1, limit));
  const main = terms[0]?.amplitude ?? 0;
  const next = terms[1]?.amplitude ?? 0;
  return main + next * 0.5;
}

function updateDrawColors() {
  const styles = getComputedStyle(body);
  drawSoftColor = styles.getPropertyValue("--draw-soft").trim() || drawSoftColor;
  drawMidColor = styles.getPropertyValue("--draw-mid").trim() || drawMidColor;
  drawGuideColor = styles.getPropertyValue("--draw-guide").trim() || drawGuideColor;
  drawLineColor = styles.getPropertyValue("--draw-line").trim() || drawLineColor;
}

function setTheme(theme) {
  const normalizedTheme = theme === "light" ? "light" : "dark";
  body.dataset.theme = normalizedTheme;
  themeToggle.checked = normalizedTheme === "dark";
  themeToggle.setAttribute(
    "aria-label",
    normalizedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode",
  );
  themeToggle.title = normalizedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  updateDrawColors();
  localStorage.setItem(STORAGE_THEME_KEY, normalizedTheme);
}

function recalcLayout() {
  WIDTH = canvas.width;
  HEIGHT = canvas.height;

  const dominantX = getDominantRadius(xSeries, visibleTerms);
  const dominantY = getDominantRadius(ySeries, visibleTerms);
  const GAP = EDGE_BASE_GAP + EDGE_EXTRA_GAP;

  // Two-pass iteration: each pass uses the previous margin to derive a
  // self-consistent scale, eliminating the seed/actual scale mismatch.
  let topMargin = MIN_TOP_MARGIN;
  let leftMargin = MIN_LEFT_MARGIN;

  for (let pass = 0; pass < 2; pass++) {
    const drawW = Math.max(120, WIDTH - leftMargin - FRAME_PADDING);
    const drawH = Math.max(120, HEIGHT - topMargin - FRAME_PADDING);
    const scale = Math.min(drawW, drawH) * DRAW_SCALE_FACTOR;

    topMargin = Math.min(
      Math.max(MIN_TOP_MARGIN, Math.round(2 * dominantX * scale + GAP)),
      Math.floor(HEIGHT * MAX_TOP_MARGIN_RATIO),
    );
    leftMargin = Math.min(
      Math.max(MIN_LEFT_MARGIN, Math.round(2 * dominantY * scale + GAP)),
      Math.floor(WIDTH * MAX_LEFT_MARGIN_RATIO),
    );
  }

  TOP_MARGIN = topMargin;
  LEFT_MARGIN = leftMargin;

  DRAW_WIDTH = Math.max(120, WIDTH - LEFT_MARGIN - FRAME_PADDING);
  DRAW_HEIGHT = Math.max(120, HEIGHT - TOP_MARGIN - FRAME_PADDING);
  DRAW_ORIGIN = { x: LEFT_MARGIN, y: TOP_MARGIN };
  DRAW_CENTER = {
    x: DRAW_ORIGIN.x + DRAW_WIDTH / 2,
    y: DRAW_ORIGIN.y + DRAW_HEIGHT / 2,
  };

  DRAW_SCALE = Math.min(DRAW_WIDTH, DRAW_HEIGHT) * DRAW_SCALE_FACTOR;

  // Center the epicycle chains perfectly within their margin band.
  TOP_CENTER_Y = Math.round(TOP_MARGIN / 2);
  LEFT_CENTER_X = Math.round(LEFT_MARGIN / 2);
}

function getSafeScale() {
  if (!xSeries.length || !ySeries.length) {
    return DRAW_SCALE;
  }

  const xDominantRadius = getDominantRadius(xSeries, visibleTerms);
  const yDominantRadius = getDominantRadius(ySeries, visibleTerms);
  const dominantRadius = Math.max(xDominantRadius, yDominantRadius);

  if (dominantRadius <= 0) {
    return DRAW_SCALE;
  }

  const topFitScale = Math.max(4, TOP_CENTER_Y - EDGE_BASE_GAP) / xDominantRadius;
  const leftFitScale = Math.max(4, LEFT_CENTER_X - EDGE_BASE_GAP) / yDominantRadius;
  return Math.min(DRAW_SCALE, topFitScale, leftFitScale);
}

function computeFourierSeries(values) {
  const sampleSize = values.length;
  const coefficients = [];

  for (let frequency = 0; frequency < sampleSize; frequency += 1) {
    let real = 0;
    let imaginary = 0;

    for (let index = 0; index < sampleSize; index += 1) {
      const angle = (2 * Math.PI * frequency * index) / sampleSize;
      real += values[index] * Math.cos(angle);
      imaginary -= values[index] * Math.sin(angle);
    }

    real /= sampleSize;
    imaginary /= sampleSize;

    const signedFrequency = frequency <= sampleSize / 2 ? frequency : frequency - sampleSize;
    coefficients.push({
      frequency: signedFrequency,
      amplitude: Math.hypot(real, imaginary),
      phase: Math.atan2(imaginary, real),
    });
  }

  return coefficients.sort((left, right) => right.amplitude - left.amplitude);
}

function evaluateSeries(coefficients, angle, limit) {
  let currentX = 0;
  let currentY = 0;
  const circles = [];
  const terms = coefficients.slice(0, limit);

  for (const term of terms) {
    const previousX = currentX;
    const previousY = currentY;
    currentX += term.amplitude * Math.cos(term.frequency * angle + term.phase);
    currentY += term.amplitude * Math.sin(term.frequency * angle + term.phase);
    circles.push({
      startX: previousX,
      startY: previousY,
      endX: currentX,
      endY: currentY,
      radius: term.amplitude,
    });
  }

  return {
    circles,
    endpoint: { x: currentX, y: currentY },
  };
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return { x, y };
}

function normalizePoints(points) {
  if (!points.length) {
    return [];
  }

  const center = points.reduce(
    (accumulator, point) => ({
      x: accumulator.x + point.x / points.length,
      y: accumulator.y + point.y / points.length,
    }),
    { x: 0, y: 0 },
  );

  const maxRadius = points.reduce((maximum, point) => {
    return Math.max(maximum, Math.hypot(point.x - center.x, point.y - center.y));
  }, 0);

  if (maxRadius < 1e-6) {
    return [];
  }

  return points.map((point) => ({
    x: (point.x - center.x) / maxRadius,
    y: (point.y - center.y) / maxRadius,
  }));
}

function resamplePolyline(points, sampleCount, closed = true) {
  if (points.length < 2) {
    return [];
  }

  const chain = closed ? [...points, points[0]] : [...points];
  const segments = [];
  let totalLength = 0;

  for (let index = 0; index < chain.length - 1; index += 1) {
    const start = chain[index];
    const end = chain[index + 1];
    const length = Math.hypot(end.x - start.x, end.y - start.y);

    if (length > 0.0001) {
      segments.push({ start, end, length, offset: totalLength });
      totalLength += length;
    }
  }

  if (totalLength <= 0 || segments.length === 0) {
    return [];
  }

  const sampled = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const distance = (index / sampleCount) * totalLength;
    const segment =
      segments.find((entry) => distance <= entry.offset + entry.length) ||
      segments[segments.length - 1];
    const localDistance = distance - segment.offset;
    const ratio = segment.length === 0 ? 0 : localDistance / segment.length;

    sampled.push({
      x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
      y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
    });
  }

  return sampled;
}

function parseSvgPoints(svgText, sampleCount) {
  const parser = new DOMParser();
  const svgDocument = parser.parseFromString(svgText, "image/svg+xml");

  if (svgDocument.querySelector("parsererror")) {
    throw new Error("Invalid SVG file.");
  }

  const rootSvg = svgDocument.querySelector("svg");
  if (!rootSvg) {
    throw new Error("SVG tag not found.");
  }

  const shape = rootSvg.querySelector("path, polygon, polyline, rect, circle, ellipse, line");
  if (!shape) {
    throw new Error(
      "No compatible shape found. Use path, polygon, polyline, rect, circle, ellipse, or line.",
    );
  }

  if (shape.tagName.toLowerCase() === "path") {
    const pathData = shape.getAttribute("d");
    if (!pathData) {
      throw new Error("Path has no d attribute.");
    }

    const tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tempPath.setAttribute("d", pathData);
    const totalLength = tempPath.getTotalLength();

    if (!Number.isFinite(totalLength) || totalLength <= 0) {
      throw new Error("Path length is not usable.");
    }

    const sampled = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const point = tempPath.getPointAtLength((index / sampleCount) * totalLength);
      sampled.push({ x: point.x, y: point.y });
    }

    return sampled;
  }

  if (shape.tagName.toLowerCase() === "polygon" || shape.tagName.toLowerCase() === "polyline") {
    const pointsAttr = shape.getAttribute("points") || "";
    const rawPoints = pointsAttr
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number))
      .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
      .map(([x, y]) => ({ x, y }));

    if (rawPoints.length < 2) {
      throw new Error("Shape has too few points.");
    }

    return resamplePolyline(rawPoints, sampleCount, shape.tagName.toLowerCase() === "polygon");
  }

  if (shape.tagName.toLowerCase() === "rect") {
    const x = Number(shape.getAttribute("x") || 0);
    const y = Number(shape.getAttribute("y") || 0);
    const width = Number(shape.getAttribute("width") || 0);
    const height = Number(shape.getAttribute("height") || 0);
    const corners = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
    return resamplePolyline(corners, sampleCount, true);
  }

  if (shape.tagName.toLowerCase() === "line") {
    const x1 = Number(shape.getAttribute("x1") || 0);
    const y1 = Number(shape.getAttribute("y1") || 0);
    const x2 = Number(shape.getAttribute("x2") || 0);
    const y2 = Number(shape.getAttribute("y2") || 0);
    return resamplePolyline(
      [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ],
      sampleCount,
      false,
    );
  }

  if (shape.tagName.toLowerCase() === "circle" || shape.tagName.toLowerCase() === "ellipse") {
    const cx = Number(shape.getAttribute("cx") || 0);
    const cy = Number(shape.getAttribute("cy") || 0);
    const rx =
      shape.tagName.toLowerCase() === "circle"
        ? Number(shape.getAttribute("r") || 0)
        : Number(shape.getAttribute("rx") || 0);
    const ry =
      shape.tagName.toLowerCase() === "circle"
        ? Number(shape.getAttribute("r") || 0)
        : Number(shape.getAttribute("ry") || 0);

    const sampled = [];
    for (let index = 0; index < sampleCount; index += 1) {
      const angle = (2 * Math.PI * index) / sampleCount;
      sampled.push({
        x: cx + rx * Math.cos(angle),
        y: cy + ry * Math.sin(angle),
      });
    }

    return sampled;
  }

  throw new Error("Could not parse the SVG.");
}

function buildSeriesFromPoints(points, message) {
  const normalized = normalizePoints(points);
  if (normalized.length < 10) {
    setStatus("Not enough points to compute Fourier.");
    return;
  }

  normalizedPoints = normalized;
  xSeries = computeFourierSeries(normalizedPoints.map((point) => point.x));
  ySeries = computeFourierSeries(normalizedPoints.map((point) => point.y));
  recalcLayout();
  trace = [];
  phase = 0;
  setStatus(message);
}

function loadDefaultStar() {
  const parser = new DOMParser();
  const svgDocument = parser.parseFromString(STAR_SVG, "image/svg+xml");
  const polygon = svgDocument.querySelector("polygon");
  const rawPoints = (polygon.getAttribute("points") || "")
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number))
    .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
    .map(([x, y]) => ({ x, y }));

  const sampled = resamplePolyline(rawPoints, SAMPLE_COUNT, true);
  buildSeriesFromPoints(sampled, "");
}

function drawLayout() {
  // Intentionally empty: keep the canvas free of framing lines.
}

function drawTopEpicycles(state, scale) {
  context.save();
  context.translate(DRAW_CENTER.x, TOP_CENTER_Y);

  for (const circle of state.circles) {
    context.strokeStyle = drawSoftColor;
    context.lineWidth = 1;
    context.beginPath();
    context.arc(
      circle.startX * scale,
      circle.startY * scale,
      circle.radius * scale,
      0,
      Math.PI * 2,
    );
    context.stroke();

    context.strokeStyle = drawMidColor;
    context.beginPath();
    context.moveTo(circle.startX * scale, circle.startY * scale);
    context.lineTo(circle.endX * scale, circle.endY * scale);
    context.stroke();
  }

  context.fillStyle = drawLineColor;
  context.beginPath();
  context.arc(state.endpoint.x * scale, state.endpoint.y * scale, 3.2, 0, Math.PI * 2);
  context.fill();

  context.restore();
}

function drawLeftEpicycles(state, scale) {
  context.save();
  context.translate(LEFT_CENTER_X, DRAW_CENTER.y);
  context.rotate(Math.PI / 2);

  for (const circle of state.circles) {
    context.strokeStyle = drawSoftColor;
    context.lineWidth = 1;
    context.beginPath();
    context.arc(
      circle.startX * scale,
      circle.startY * scale,
      circle.radius * scale,
      0,
      Math.PI * 2,
    );
    context.stroke();

    context.strokeStyle = drawMidColor;
    context.beginPath();
    context.moveTo(circle.startX * scale, circle.startY * scale);
    context.lineTo(circle.endX * scale, circle.endY * scale);
    context.stroke();
  }

  context.fillStyle = drawLineColor;
  context.beginPath();
  context.arc(state.endpoint.x * scale, state.endpoint.y * scale, 3.2, 0, Math.PI * 2);
  context.fill();

  context.restore();
}

function drawGuides(topTip, leftTip, point) {
  context.save();
  context.strokeStyle = drawGuideColor;
  context.lineWidth = 1;
  context.setLineDash([4, 6]);

  context.beginPath();
  context.moveTo(topTip.x, topTip.y);
  context.lineTo(point.x, point.y);
  context.moveTo(leftTip.x, leftTip.y);
  context.lineTo(point.x, point.y);
  context.stroke();
  context.restore();
}

function drawTracePath() {
  if (trace.length < 2) {
    return;
  }

  context.save();
  context.lineWidth = 2.1;
  context.lineCap = "round";
  context.lineJoin = "round";
  const FADE_ZONE = 0.12;
  for (let index = 1; index < trace.length; index += 1) {
    const age = (phase - trace[index].phase + 1) % 1;
    const t = 1 - age / TRAIL_RATIO;
    context.globalAlpha = Math.min(1, t / FADE_ZONE) * 0.95;
    context.strokeStyle = drawLineColor;
    context.beginPath();
    context.moveTo(trace[index - 1].x, trace[index - 1].y);
    context.lineTo(trace[index].x, trace[index].y);
    context.stroke();
  }
  context.restore();
}

function drawCurrentPoint(point) {
  context.save();
  context.fillStyle = drawLineColor;
  context.beginPath();
  context.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawFreehandPreview() {
  context.save();
  context.strokeStyle = drawLineColor;
  context.lineWidth = 2.2;
  context.lineCap = "round";
  context.lineJoin = "round";

  if (drawPreviewPoints.length > 1) {
    context.beginPath();
    context.moveTo(drawPreviewPoints[0].x, drawPreviewPoints[0].y);
    for (let index = 1; index < drawPreviewPoints.length; index += 1) {
      context.lineTo(drawPreviewPoints[index].x, drawPreviewPoints[index].y);
    }
    context.stroke();
  }

  context.restore();
}

function drawFourierFrame() {
  if (!xSeries.length || !ySeries.length) {
    return;
  }

  const angle = phase * 2 * Math.PI;
  const xState = evaluateSeries(xSeries, angle, visibleTerms);
  const yState = evaluateSeries(ySeries, angle, visibleTerms);
  const safeScale = getSafeScale();

  const topTip = {
    x: DRAW_CENTER.x + xState.endpoint.x * safeScale,
    y: TOP_CENTER_Y + xState.endpoint.y * safeScale,
  };

  const leftTip = {
    x: LEFT_CENTER_X - yState.endpoint.y * safeScale,
    y: DRAW_CENTER.y + yState.endpoint.x * safeScale,
  };

  const currentPoint = {
    x: DRAW_CENTER.x + xState.endpoint.x * safeScale,
    y: DRAW_CENTER.y + yState.endpoint.x * safeScale,
    phase,
  };

  trace.push(currentPoint);
  // Evict points older than TRAIL_RATIO of one full cycle.
  while (trace.length > 1) {
    const age = (phase - trace[0].phase + 1) % 1;
    if (age > TRAIL_RATIO) {
      trace.shift();
    } else {
      break;
    }
  }

  drawLayout();
  drawTopEpicycles(xState, safeScale);
  drawLeftEpicycles(yState, safeScale);
  drawGuides(topTip, leftTip, currentPoint);
  drawTracePath();
  drawCurrentPoint(currentPoint);
}

function animationLoop(timestamp) {
  if (!lastTimestamp) {
    lastTimestamp = timestamp;
  }

  const deltaSeconds = (timestamp - lastTimestamp) / 1000;
  lastTimestamp = timestamp;

  if (!document.hidden && !isPaused && xSeries.length && ySeries.length) {
    phase = (phase + deltaSeconds * speed) % 1;
  }

  context.clearRect(0, 0, WIDTH, HEIGHT);

  if (sourceMode === "draw" && !xSeries.length) {
    drawFreehandPreview();
  } else {
    drawFourierFrame();
  }

  requestAnimationFrame(animationLoop);
}

function switchSourceMode(mode) {
  sourceMode = mode;
  const drawMode = sourceMode === "draw";

  svgFileInput.disabled = drawMode;
  sampleStarButton.disabled = drawMode;
  acceptDrawButton.hidden = !drawMode;
  clearDrawButton.hidden = !drawMode;
  acceptDrawButton.disabled = !drawMode || pendingDrawSampledPoints.length === 0;
  clearDrawButton.disabled = !drawMode;

  trace = [];

  if (drawMode) {
    xSeries = [];
    ySeries = [];
    normalizedPoints = [];
    drawPoints = [];
    drawPreviewPoints = [];
    pendingDrawSampledPoints = [];
    acceptDrawButton.disabled = true;
    setStatus("Draw mode active. Canvas is blank. Draw with your mouse.");
  } else {
    drawPreviewPoints = [];
    drawPoints = [];
    pendingDrawSampledPoints = [];
    acceptDrawButton.disabled = true;
    setStatus("SVG mode active.");
  }
}

function handlePointerDown(event) {
  if (sourceMode !== "draw") {
    return;
  }

  isDrawing = true;
  drawPoints = [];
  drawPreviewPoints = [];
  pendingDrawSampledPoints = [];
  xSeries = [];
  ySeries = [];
  normalizedPoints = [];
  trace = [];
  acceptDrawButton.disabled = true;

  const point = getCanvasPoint(event);
  drawPoints.push(point);
  drawPreviewPoints.push(point);
  canvas.setPointerCapture(event.pointerId);
}

function handlePointerMove(event) {
  if (!isDrawing || sourceMode !== "draw") {
    return;
  }

  const point = getCanvasPoint(event);
  const lastPoint = drawPoints[drawPoints.length - 1];

  if (!lastPoint || Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) > 1.8) {
    drawPoints.push(point);
    drawPreviewPoints.push(point);
  }
}

function handlePointerUp(event) {
  if (!isDrawing || sourceMode !== "draw") {
    return;
  }

  isDrawing = false;
  canvas.releasePointerCapture(event.pointerId);

  if (drawPoints.length < 8) {
    drawPoints = [];
    drawPreviewPoints = [];
    pendingDrawSampledPoints = [];
    acceptDrawButton.disabled = true;
    setStatus("Drawing is too short. Draw a longer shape.");
    return;
  }

  pendingDrawSampledPoints = resamplePolyline(drawPoints, SAMPLE_COUNT, true);
  acceptDrawButton.disabled = pendingDrawSampledPoints.length === 0;
  if (pendingDrawSampledPoints.length > 0) {
    setStatus("Drawing ready. Click Accept.");
  }
}

async function handleSvgUpload(file) {
  if (!file) {
    return;
  }

  if (file.type !== "image/svg+xml" && !file.name.toLowerCase().endsWith(".svg")) {
    setStatus("Invalid file. Please select an SVG.");
    svgFileInput.value = "";
    return;
  }

  if (file.size > MAX_SVG_SIZE_BYTES) {
    setStatus("SVG is larger than 2 MB. Use a smaller file.");
    svgFileInput.value = "";
    return;
  }

  try {
    const text = await file.text();
    const sampled = parseSvgPoints(text, SAMPLE_COUNT);
    buildSeriesFromPoints(sampled, `SVG loaded: ${file.name}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not read SVG.");
  }
}

function bindUI() {
  const storedTheme = localStorage.getItem(STORAGE_THEME_KEY);
  setTheme(storedTheme || "dark");
  speed = mapUiSpeedToInternal(Number(speedRange.value));
  speedValue.value = String(Number(speedRange.value));

  document.addEventListener("visibilitychange", () => {
    lastTimestamp = 0;
  });

  themeToggle.addEventListener("change", () => {
    const nextTheme = themeToggle.checked ? "dark" : "light";
    setTheme(nextTheme);
  });

  sourceModeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        switchSourceMode(input.value);
      }
    });
  });

  svgFileInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    handleSvgUpload(file);
  });

  sampleStarButton.addEventListener("click", () => {
    switchSourceMode("upload");
    const uploadRadio = document.querySelector('input[name="source-mode"][value="upload"]');
    if (uploadRadio) {
      uploadRadio.checked = true;
    }
    loadDefaultStar();
  });

  clearDrawButton.addEventListener("click", () => {
    if (sourceMode !== "draw") {
      return;
    }
    drawPoints = [];
    drawPreviewPoints = [];
    pendingDrawSampledPoints = [];
    normalizedPoints = [];
    xSeries = [];
    ySeries = [];
    trace = [];
    acceptDrawButton.disabled = true;
    setStatus("Canvas cleared. Draw a new shape.");
  });

  acceptDrawButton.addEventListener("click", () => {
    if (sourceMode !== "draw" || pendingDrawSampledPoints.length === 0) {
      return;
    }

    buildSeriesFromPoints(pendingDrawSampledPoints, "");
    acceptDrawButton.disabled = true;
    drawPoints = [];
  });

  termsRange.addEventListener("input", () => {
    visibleTerms = Number(termsRange.value);
    termsValue.value = String(visibleTerms);
    recalcLayout();
    trace = [];
  });

  speedRange.addEventListener("input", () => {
    speed = mapUiSpeedToInternal(Number(speedRange.value));
    speedValue.value = String(Number(speedRange.value));
  });

  pauseButton.addEventListener("click", () => {
    isPaused = !isPaused;
    pauseButton.textContent = isPaused ? "Resume" : "Pause";
    pauseButton.setAttribute("aria-pressed", isPaused ? "true" : "false");
  });

  resetTraceButton.addEventListener("click", () => {
    trace = [];
    phase = 0;
    setStatus("Trace reset.");
  });

  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", handlePointerUp);
  canvas.addEventListener("pointercancel", handlePointerUp);
}

function initCanvasSizeHandling() {
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      canvas.width = Math.round(width);
      canvas.height = Math.round(height);
      recalcLayout();
      trace = [];
      if (sourceMode === "draw" && drawPreviewPoints.length > 0) {
        drawPreviewPoints = [];
      }
    }
  });
  resizeObserver.observe(canvas);

  const initialRect = canvas.getBoundingClientRect();
  canvas.width = Math.round(initialRect.width) || 800;
  canvas.height = Math.round(initialRect.height) || 600;
  recalcLayout();
}

bindUI();
initCanvasSizeHandling();
loadDefaultStar();
requestAnimationFrame(animationLoop);
