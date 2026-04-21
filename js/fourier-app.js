import {
  DRAW_SCALE_FACTOR,
  EDGE_BASE_GAP,
  EDGE_EXTRA_GAP,
  FRAME_PADDING,
  HARMONICS_UI_DEFAULT,
  HARMONICS_UI_MAX,
  HARMONICS_UI_MIN,
  HARMONICS_UI_STEP,
  MAX_IMAGE_SIZE_BYTES,
  MAX_LEFT_MARGIN_RATIO,
  MAX_SVG_SIZE_BYTES,
  MAX_TOP_MARGIN_RATIO,
  MIN_LEFT_MARGIN,
  MIN_TOP_MARGIN,
  SPEED_UI_DEFAULT,
  SPEED_UI_MAX,
  SPEED_UI_MIN,
  SPEED_UI_STEP,
  STAR_SVG,
  STORAGE_THEME_KEY,
} from "./config.js";
import {
  computeFourierSeries,
  evaluateSeries,
  getDominantRadius,
  getSafeScale,
  mapUiSpeedToInternal,
  parseSvgPoints,
  resamplePolyline,
} from "./fourier-utils.js";
import { extractContourFromRaster } from "./image-processing.js";

export class FourierApp {
  constructor(documentRef) {
    this.document = documentRef;
    this.canvas = documentRef.getElementById("fourier-canvas");
    this.context = this.canvas.getContext("2d");
    this.body = documentRef.body;
    this.controls = {
      themeToggle: documentRef.getElementById("theme-toggle"),
      sourceModeInputs: documentRef.querySelectorAll('input[name="source-mode"]'),
      fileInput: documentRef.getElementById("image-file"),
      sampleShapeSelect: documentRef.getElementById("sample-shape-select"),
      sampleStarButton: documentRef.getElementById("sample-star-btn"),
      acceptDrawButton: documentRef.getElementById("accept-draw-btn"),
      clearDrawButton: documentRef.getElementById("clear-draw-btn"),
      termsRange: documentRef.getElementById("terms-range"),
      termsValue: documentRef.getElementById("terms-value"),
      speedRange: documentRef.getElementById("speed-range"),
      speedValue: documentRef.getElementById("speed-value"),
      pauseButton: documentRef.getElementById("pause-btn"),
      resetTraceButton: documentRef.getElementById("reset-trace-btn"),
      statusOutput: documentRef.getElementById("status"),
    };
    this.layout = {
      width: 0,
      height: 0,
      topMargin: 0,
      leftMargin: 0,
      drawWidth: 0,
      drawHeight: 0,
      drawOrigin: { x: 0, y: 0 },
      drawCenter: { x: 0, y: 0 },
      topCenterY: 0,
      leftCenterX: 0,
      drawScale: 1,
    };
    this.state = {
      sourceMode: "upload",
      normalizedPoints: [],
      referenceContours: [],
      pointDrawMask: [],
      showBridgeDebug: false,
      referencePathLength: 0,
      currentPathLength: 0,
      xSeries: [],
      ySeries: [],
      trace: [],
      visibleTerms: HARMONICS_UI_DEFAULT,
      speed: mapUiSpeedToInternal(SPEED_UI_DEFAULT),
      isPaused: false,
      phase: 0,
      lastTimestamp: 0,
      isDrawing: false,
      drawPoints: [],
      drawPreviewPoints: [],
      pendingDrawSampledPoints: [],
    };
    this.colors = {
      soft: "rgba(255, 255, 255, 0.2)",
      mid: "rgba(255, 255, 255, 0.65)",
      guide: "rgba(255, 255, 255, 0.35)",
      reference: "rgba(102, 183, 255, 0.4)",
      bridgeDebug: "#ff3b3b",
      line: "#ffffff",
    };

    this.animationLoop = this.animationLoop.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
    this.handleKeydown = this.handleKeydown.bind(this);
  }

  init() {
    this.initializeControlDefaults();
    const storedTheme = localStorage.getItem(STORAGE_THEME_KEY);
    this.setTheme(storedTheme || "dark");
    this.bindUI();
    this.initCanvasSizeHandling();
    this.loadDefaultStar();
    requestAnimationFrame(this.animationLoop);
  }

  initializeControlDefaults() {
    this.controls.termsRange.min = String(HARMONICS_UI_MIN);
    this.controls.termsRange.max = String(HARMONICS_UI_MAX);
    this.controls.termsRange.step = String(HARMONICS_UI_STEP);
    this.controls.termsRange.value = String(HARMONICS_UI_DEFAULT);
    this.controls.termsValue.value = String(HARMONICS_UI_DEFAULT);

    this.controls.speedRange.min = String(SPEED_UI_MIN);
    this.controls.speedRange.max = String(SPEED_UI_MAX);
    this.controls.speedRange.step = String(SPEED_UI_STEP);
    this.controls.speedRange.value = String(SPEED_UI_DEFAULT);
    this.controls.speedValue.value = String(SPEED_UI_DEFAULT);

    this.state.visibleTerms = HARMONICS_UI_DEFAULT;
    this.state.speed = mapUiSpeedToInternal(SPEED_UI_DEFAULT);
  }

  setStatus(message) {
    this.controls.statusOutput.textContent = message;
  }

  updateDrawColors() {
    const styles = getComputedStyle(this.body);
    this.colors.soft = styles.getPropertyValue("--draw-soft").trim() || this.colors.soft;
    this.colors.mid = styles.getPropertyValue("--draw-mid").trim() || this.colors.mid;
    this.colors.guide = styles.getPropertyValue("--draw-guide").trim() || this.colors.guide;
    this.colors.line = styles.getPropertyValue("--draw-line").trim() || this.colors.line;
    this.colors.reference =
      styles.getPropertyValue("--draw-reference").trim() || this.colors.reference;
    this.colors.bridgeDebug =
      styles.getPropertyValue("--draw-bridge-debug").trim() || this.colors.bridgeDebug;
  }

  setTheme(theme) {
    const normalizedTheme = theme === "light" ? "light" : "dark";
    this.body.dataset.theme = normalizedTheme;
    this.controls.themeToggle.checked = normalizedTheme === "dark";
    this.controls.themeToggle.setAttribute(
      "aria-label",
      normalizedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode",
    );
    this.controls.themeToggle.title =
      normalizedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    this.updateDrawColors();
    localStorage.setItem(STORAGE_THEME_KEY, normalizedTheme);
  }

  recalcLayout() {
    this.layout.width = this.canvas.width;
    this.layout.height = this.canvas.height;

    const dominantX = getDominantRadius(this.state.xSeries, this.state.visibleTerms);
    const dominantY = getDominantRadius(this.state.ySeries, this.state.visibleTerms);
    const gap = EDGE_BASE_GAP + EDGE_EXTRA_GAP;

    let topMargin = MIN_TOP_MARGIN;
    let leftMargin = MIN_LEFT_MARGIN;

    for (let pass = 0; pass < 2; pass += 1) {
      const drawWidth = Math.max(120, this.layout.width - leftMargin - FRAME_PADDING);
      const drawHeight = Math.max(120, this.layout.height - topMargin - FRAME_PADDING);
      const scale = Math.min(drawWidth, drawHeight) * DRAW_SCALE_FACTOR;

      topMargin = Math.min(
        Math.max(MIN_TOP_MARGIN, Math.round(2 * dominantX * scale + gap)),
        Math.floor(this.layout.height * MAX_TOP_MARGIN_RATIO),
      );
      leftMargin = Math.min(
        Math.max(MIN_LEFT_MARGIN, Math.round(2 * dominantY * scale + gap)),
        Math.floor(this.layout.width * MAX_LEFT_MARGIN_RATIO),
      );
    }

    this.layout.topMargin = topMargin;
    this.layout.leftMargin = leftMargin;
    this.layout.drawWidth = Math.max(120, this.layout.width - leftMargin - FRAME_PADDING);
    this.layout.drawHeight = Math.max(120, this.layout.height - topMargin - FRAME_PADDING);
    this.layout.drawOrigin = { x: leftMargin, y: topMargin };
    this.layout.drawCenter = {
      x: this.layout.drawOrigin.x + this.layout.drawWidth / 2,
      y: this.layout.drawOrigin.y + this.layout.drawHeight / 2,
    };
    this.layout.drawScale =
      Math.min(this.layout.drawWidth, this.layout.drawHeight) * DRAW_SCALE_FACTOR;
    const headerEl = this.document.querySelector("header");
    const headerBottomPx = headerEl ? headerEl.getBoundingClientRect().bottom : 0;
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasScaleY = canvasRect.height > 0 ? this.canvas.height / canvasRect.height : 1;
    const headerOffsetCanvas = Math.ceil(headerBottomPx * canvasScaleY) + 10;

    this.layout.topCenterY = Math.max(headerOffsetCanvas, Math.round(topMargin / 2));
    this.layout.leftCenterX = Math.round(leftMargin / 2);
  }

  getCanvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * this.canvas.height;
    return { x, y };
  }

  computePathLength(points, isClosed = true) {
    if (!points || points.length < 2) {
      return 0;
    }

    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      total += Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      );
    }

    if (isClosed) {
      const first = points[0];
      const last = points[points.length - 1];
      total += Math.hypot(first.x - last.x, first.y - last.y);
    }

    return total;
  }

  computeNormalizationTransform(points) {
    if (!points.length) {
      return null;
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
      return null;
    }

    return { center, maxRadius };
  }

  normalizeWithTransform(points, transform) {
    return points.map((point) => ({
      x: (point.x - transform.center.x) / transform.maxRadius,
      y: (point.y - transform.center.y) / transform.maxRadius,
    }));
  }

  buildSeriesFromPoints(points, message, options = {}) {
    const isClosed = options.isClosed ?? true;
    const setAsSpeedReference = options.setAsSpeedReference ?? false;
    const transform = this.computeNormalizationTransform(points);
    if (!transform) {
      this.setStatus("Not enough points to compute Fourier.");
      return;
    }

    const normalized = this.normalizeWithTransform(points, transform);
    if (normalized.length < 10) {
      this.setStatus("Not enough points to compute Fourier.");
      return;
    }

    this.state.normalizedPoints = normalized;
    const sourceReferenceContours =
      Array.isArray(options.referenceContours) && options.referenceContours.length
        ? options.referenceContours
        : [{ points, isClosed }];
    this.state.referenceContours = sourceReferenceContours
      .filter((contour) => Array.isArray(contour.points) && contour.points.length >= 2)
      .map((contour) => ({
        isClosed: Boolean(contour.isClosed),
        points: this.normalizeWithTransform(contour.points, transform),
      }));

    this.state.pointDrawMask =
      Array.isArray(options.drawMask) && options.drawMask.length === normalized.length
        ? options.drawMask.map((value) => Boolean(value))
        : new Array(normalized.length).fill(true);

    this.state.currentPathLength = this.computePathLength(normalized, isClosed);
    if (setAsSpeedReference || this.state.referencePathLength <= 0) {
      this.state.referencePathLength = Math.max(1e-6, this.state.currentPathLength);
    }
    this.state.xSeries = computeFourierSeries(normalized.map((point) => point.x));
    this.state.ySeries = computeFourierSeries(normalized.map((point) => point.y));
    this.recalcLayout();
    this.state.trace = [];
    this.state.phase = 0;
    this.setStatus(message);
  }

  loadDefaultStar() {
    const initial = parseSvgPoints(STAR_SVG);
    const sampleCount = Math.max(10, Math.round(initial.points.length * 0.9));
    const sampled = parseSvgPoints(STAR_SVG, sampleCount);
    this.buildSeriesFromPoints(sampled.points, "", {
      isClosed: sampled.isClosed,
      setAsSpeedReference: true,
      drawMask: sampled.drawMask,
      referenceContours: sampled.referenceContours,
    });
  }

  async loadSampleByKey(sampleKey) {
    let svgText = STAR_SVG;
    if (sampleKey === "one-piece-flag") {
      const response = await fetch("./one_piece_flag.svg", { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Could not load One Piece flag sample.");
      }
      svgText = await response.text();
    }

    const initial = parseSvgPoints(svgText);
    const sampleCount = Math.max(10, Math.round(initial.points.length * 0.9));
    const sampled = parseSvgPoints(svgText, sampleCount);
    this.buildSeriesFromPoints(sampled.points, "", {
      isClosed: sampled.isClosed,
      drawMask: sampled.drawMask,
      referenceContours: sampled.referenceContours,
      setAsSpeedReference: sampleKey === "star",
    });
  }

  drawReferenceContour(scale) {
    if (!this.state.referenceContours.length) {
      return;
    }

    this.context.save();
    this.context.strokeStyle = this.colors.reference;
    this.context.lineWidth = 1.6;
    this.context.lineCap = "round";
    this.context.lineJoin = "round";
    this.context.setLineDash([5, 4]);
    for (const contour of this.state.referenceContours) {
      if (contour.points.length < 2) {
        continue;
      }
      this.context.beginPath();
      const first = contour.points[0];
      this.context.moveTo(
        this.layout.drawCenter.x + first.x * scale,
        this.layout.drawCenter.y + first.y * scale,
      );

      for (let index = 1; index < contour.points.length; index += 1) {
        const point = contour.points[index];
        this.context.lineTo(
          this.layout.drawCenter.x + point.x * scale,
          this.layout.drawCenter.y + point.y * scale,
        );
      }

      if (contour.isClosed) {
        this.context.closePath();
      }
      this.context.stroke();
    }
    this.context.restore();
  }

  drawTopEpicycles(state, scale) {
    this.context.save();
    this.context.translate(this.layout.drawCenter.x, this.layout.topCenterY);

    for (const circle of state.circles) {
      this.context.strokeStyle = this.colors.soft;
      this.context.lineWidth = 1;
      this.context.beginPath();
      this.context.arc(
        circle.startX * scale,
        circle.startY * scale,
        circle.radius * scale,
        0,
        Math.PI * 2,
      );
      this.context.stroke();

      this.context.strokeStyle = this.colors.mid;
      this.context.beginPath();
      this.context.moveTo(circle.startX * scale, circle.startY * scale);
      this.context.lineTo(circle.endX * scale, circle.endY * scale);
      this.context.stroke();
    }

    this.context.fillStyle = this.colors.line;
    this.context.beginPath();
    this.context.arc(state.endpoint.x * scale, state.endpoint.y * scale, 3.2, 0, Math.PI * 2);
    this.context.fill();
    this.context.restore();
  }

  drawLeftEpicycles(state, scale) {
    this.context.save();
    this.context.translate(this.layout.leftCenterX, this.layout.drawCenter.y);
    this.context.rotate(Math.PI / 2);

    for (const circle of state.circles) {
      this.context.strokeStyle = this.colors.soft;
      this.context.lineWidth = 1;
      this.context.beginPath();
      this.context.arc(
        circle.startX * scale,
        circle.startY * scale,
        circle.radius * scale,
        0,
        Math.PI * 2,
      );
      this.context.stroke();

      this.context.strokeStyle = this.colors.mid;
      this.context.beginPath();
      this.context.moveTo(circle.startX * scale, circle.startY * scale);
      this.context.lineTo(circle.endX * scale, circle.endY * scale);
      this.context.stroke();
    }

    this.context.fillStyle = this.colors.line;
    this.context.beginPath();
    this.context.arc(state.endpoint.x * scale, state.endpoint.y * scale, 3.2, 0, Math.PI * 2);
    this.context.fill();
    this.context.restore();
  }

  drawGuides(topTip, leftTip, point) {
    this.context.save();
    this.context.strokeStyle = this.colors.guide;
    this.context.lineWidth = 1;
    this.context.setLineDash([4, 6]);
    this.context.beginPath();
    this.context.moveTo(topTip.x, topTip.y);
    this.context.lineTo(point.x, point.y);
    this.context.moveTo(leftTip.x, leftTip.y);
    this.context.lineTo(point.x, point.y);
    this.context.stroke();
    this.context.restore();
  }

  drawTracePath() {
    if (this.state.trace.length < 2) {
      return;
    }

    this.context.save();
    this.context.lineWidth = 2.1;
    this.context.lineCap = "round";
    this.context.lineJoin = "round";
    this.context.globalAlpha = 1;
    this.context.strokeStyle = this.colors.line;
    this.context.beginPath();

    let hasDrawnSegment = false;
    let hasDebugBridgeSegment = false;
    let openSubpath = false;

    if (this.state.showBridgeDebug) {
      this.context.strokeStyle = this.colors.line;
    }

    for (let index = 1; index < this.state.trace.length; index += 1) {
      const previous = this.state.trace[index - 1];
      const current = this.state.trace[index];
      const shouldDraw = previous.penDown && current.penDown;

      if (shouldDraw) {
        if (!openSubpath) {
          this.context.moveTo(previous.x, previous.y);
          openSubpath = true;
        }
        this.context.lineTo(current.x, current.y);
        hasDrawnSegment = true;
      } else {
        if (this.state.showBridgeDebug) {
          this.context.save();
          this.context.strokeStyle = this.colors.bridgeDebug;
          this.context.lineWidth = 1.8;
          this.context.beginPath();
          this.context.moveTo(previous.x, previous.y);
          this.context.lineTo(current.x, current.y);
          this.context.stroke();
          this.context.restore();
          hasDebugBridgeSegment = true;
        }
        openSubpath = false;
      }
    }

    if (hasDrawnSegment) {
      this.context.strokeStyle = this.colors.line;
      this.context.stroke();
    }

    if (this.state.showBridgeDebug && hasDebugBridgeSegment) {
      this.context.save();
      const point = this.state.trace[this.state.trace.length - 1];
      if (!point.penDown) {
        this.context.fillStyle = this.colors.bridgeDebug;
        this.context.beginPath();
        this.context.arc(point.x, point.y, 2.8, 0, Math.PI * 2);
        this.context.fill();
      }
      this.context.restore();
    }

    this.context.restore();
  }

  drawCurrentPoint(point) {
    this.context.save();
    this.context.fillStyle = this.colors.line;
    this.context.beginPath();
    this.context.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
    this.context.fill();
    this.context.restore();
  }

  drawFreehandPreview() {
    if (this.state.drawPreviewPoints.length < 2) {
      return;
    }

    this.context.save();
    this.context.strokeStyle = this.colors.line;
    this.context.lineWidth = 2.2;
    this.context.lineCap = "round";
    this.context.lineJoin = "round";
    this.context.beginPath();
    this.context.moveTo(this.state.drawPreviewPoints[0].x, this.state.drawPreviewPoints[0].y);

    for (let index = 1; index < this.state.drawPreviewPoints.length; index += 1) {
      this.context.lineTo(
        this.state.drawPreviewPoints[index].x,
        this.state.drawPreviewPoints[index].y,
      );
    }

    this.context.stroke();
    this.context.restore();
  }

  drawFourierFrame() {
    if (!this.state.xSeries.length || !this.state.ySeries.length) {
      return;
    }

    const angle = this.state.phase * 2 * Math.PI;
    const xState = evaluateSeries(this.state.xSeries, angle, this.state.visibleTerms);
    const yState = evaluateSeries(this.state.ySeries, angle, this.state.visibleTerms);
    const safeScale = getSafeScale(
      this.layout,
      this.state.xSeries,
      this.state.ySeries,
      this.state.visibleTerms,
      this.layout.drawScale,
    );

    const topTip = {
      x: this.layout.drawCenter.x + xState.endpoint.x * safeScale,
      y: this.layout.topCenterY + xState.endpoint.y * safeScale,
    };
    const leftTip = {
      x: this.layout.leftCenterX - yState.endpoint.y * safeScale,
      y: this.layout.drawCenter.y + yState.endpoint.x * safeScale,
    };
    const currentPoint = {
      x: this.layout.drawCenter.x + xState.endpoint.x * safeScale,
      y: this.layout.drawCenter.y + yState.endpoint.x * safeScale,
      penDown:
        this.state.pointDrawMask[
          Math.min(
            this.state.pointDrawMask.length - 1,
            Math.floor(this.state.phase * this.state.pointDrawMask.length),
          )
        ] ?? true,
    };

    this.state.trace.push(currentPoint);

    this.drawReferenceContour(safeScale);
    this.drawTopEpicycles(xState, safeScale);
    this.drawLeftEpicycles(yState, safeScale);
    this.drawGuides(topTip, leftTip, currentPoint);
    this.drawTracePath();
    this.drawCurrentPoint(currentPoint);
  }

  animationLoop(timestamp) {
    if (!this.state.lastTimestamp) {
      this.state.lastTimestamp = timestamp;
    }

    const deltaSeconds = (timestamp - this.state.lastTimestamp) / 1000;
    this.state.lastTimestamp = timestamp;

    if (
      !this.document.hidden &&
      !this.state.isPaused &&
      this.state.xSeries.length &&
      this.state.ySeries.length
    ) {
      const previousPhase = this.state.phase;
      const speedLengthScale =
        this.state.currentPathLength > 1e-6 && this.state.referencePathLength > 1e-6
          ? this.state.referencePathLength / this.state.currentPathLength
          : 1;
      const clampedScale = Math.max(0.15, Math.min(3, speedLengthScale));
      const nextPhase = (this.state.phase + deltaSeconds * this.state.speed * clampedScale) % 1;
      const wrapped = nextPhase < previousPhase;
      this.state.phase = nextPhase;
      if (wrapped) {
        this.state.trace = [];
      }
    }

    this.context.clearRect(0, 0, this.layout.width, this.layout.height);

    if (this.state.sourceMode === "draw" && !this.state.xSeries.length) {
      this.drawFreehandPreview();
    } else {
      this.drawFourierFrame();
    }

    requestAnimationFrame(this.animationLoop);
  }

  resetPendingDrawing() {
    this.state.drawPoints = [];
    this.state.drawPreviewPoints = [];
    this.state.pendingDrawSampledPoints = [];
  }

  resetSeries() {
    this.state.normalizedPoints = [];
    this.state.referenceContours = [];
    this.state.pointDrawMask = [];
    this.state.currentPathLength = 0;
    this.state.xSeries = [];
    this.state.ySeries = [];
    this.state.trace = [];
  }

  switchSourceMode(mode) {
    this.state.sourceMode = mode;
    const drawMode = mode === "draw";

    this.controls.fileInput.disabled = drawMode;
    this.controls.sampleShapeSelect.disabled = drawMode;
    this.controls.sampleStarButton.disabled = drawMode;
    this.controls.acceptDrawButton.hidden = !drawMode;
    this.controls.clearDrawButton.hidden = !drawMode;
    this.controls.acceptDrawButton.disabled =
      !drawMode || this.state.pendingDrawSampledPoints.length === 0;
    this.controls.clearDrawButton.disabled = !drawMode;
    this.state.trace = [];

    if (drawMode) {
      this.resetSeries();
      this.resetPendingDrawing();
      this.controls.acceptDrawButton.disabled = true;
      this.setStatus("");
      return;
    }

    this.resetPendingDrawing();
    this.controls.acceptDrawButton.disabled = true;
    this.setStatus("");
  }

  handlePointerDown(event) {
    if (this.state.sourceMode !== "draw") {
      return;
    }

    this.state.isDrawing = true;
    this.resetPendingDrawing();
    this.resetSeries();
    this.controls.acceptDrawButton.disabled = true;

    const point = this.getCanvasPoint(event);
    this.state.drawPoints.push(point);
    this.state.drawPreviewPoints.push(point);
    this.canvas.setPointerCapture(event.pointerId);
  }

  handlePointerMove(event) {
    if (!this.state.isDrawing || this.state.sourceMode !== "draw") {
      return;
    }

    const point = this.getCanvasPoint(event);
    const lastPoint = this.state.drawPoints[this.state.drawPoints.length - 1];

    if (!lastPoint || Math.hypot(point.x - lastPoint.x, point.y - lastPoint.y) > 1.8) {
      this.state.drawPoints.push(point);
      this.state.drawPreviewPoints.push(point);
    }
  }

  handlePointerUp(event) {
    if (!this.state.isDrawing || this.state.sourceMode !== "draw") {
      return;
    }

    this.state.isDrawing = false;
    this.canvas.releasePointerCapture(event.pointerId);

    if (this.state.drawPoints.length < 8) {
      this.resetPendingDrawing();
      this.controls.acceptDrawButton.disabled = true;
      this.setStatus("Drawing is too short. Draw a longer shape.");
      return;
    }

    const sampleCount = Math.max(10, Math.round(this.state.drawPoints.length * 0.9));
    this.state.pendingDrawSampledPoints = resamplePolyline(
      this.state.drawPoints,
      sampleCount,
      false,
    );
    this.controls.acceptDrawButton.disabled = this.state.pendingDrawSampledPoints.length === 0;

    if (this.state.pendingDrawSampledPoints.length > 0) {
      this.setStatus("");
    }
  }

  async handleFileUpload(file) {
    if (!file) {
      return;
    }

    const isSvg = file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
    const isImage = file.type.startsWith("image/");

    if (!isSvg && !isImage) {
      this.setStatus("Unsupported file. Use an image (SVG, PNG, JPG, etc.).");
      this.controls.fileInput.value = "";
      return;
    }

    try {
      if (isSvg) {
        if (file.size > MAX_SVG_SIZE_BYTES) {
          this.setStatus("SVG is larger than 2 MB. Use a smaller file.");
          this.controls.fileInput.value = "";
          return;
        }
        const text = await file.text();
        const initial = parseSvgPoints(text);
        const sampleCount = Math.max(10, Math.round(initial.points.length * 0.9));
        const sampled = parseSvgPoints(text, sampleCount);
        this.buildSeriesFromPoints(sampled.points, "", {
          isClosed: sampled.isClosed,
          drawMask: sampled.drawMask,
          referenceContours: sampled.referenceContours,
        });
      } else {
        if (file.size > MAX_IMAGE_SIZE_BYTES) {
          this.setStatus("Image is larger than 10 MB. Use a smaller file.");
          this.controls.fileInput.value = "";
          return;
        }
        this.setStatus("Detecting edges\u2026");
        const sampled = await extractContourFromRaster(file);
        const sampleCount = Math.max(10, Math.round(sampled.points.length * 0.9));
        const resampled = resamplePolyline(sampled.points, sampleCount, sampled.isClosed);
        this.buildSeriesFromPoints(resampled, "", {
          isClosed: sampled.isClosed,
          drawMask: sampled.drawMask,
          referenceContours: sampled.referenceContours,
        });
      }
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Could not process file.");
    }
  }

  handleVisibilityChange() {
    this.state.lastTimestamp = 0;
  }

  handleThemeToggle() {
    const nextTheme = this.controls.themeToggle.checked ? "dark" : "light";
    this.setTheme(nextTheme);
  }

  async handleSampleStar() {
    this.switchSourceMode("upload");
    const uploadRadio = this.document.querySelector('input[name="source-mode"][value="upload"]');
    if (uploadRadio) {
      uploadRadio.checked = true;
    }

    const selectedSample = this.controls.sampleShapeSelect?.value || "star";
    try {
      await this.loadSampleByKey(selectedSample);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Could not load sample shape.");
    }
  }

  handleClearDrawing() {
    if (this.state.sourceMode !== "draw") {
      return;
    }

    this.resetPendingDrawing();
    this.resetSeries();
    this.controls.acceptDrawButton.disabled = true;
    this.setStatus("");
  }

  handleAcceptDrawing() {
    if (this.state.sourceMode !== "draw" || this.state.pendingDrawSampledPoints.length === 0) {
      return;
    }

    this.buildSeriesFromPoints(this.state.pendingDrawSampledPoints, "", {
      isClosed: false,
    });
    this.controls.acceptDrawButton.disabled = true;
    this.state.drawPoints = [];
  }

  handleTermsChange() {
    this.state.visibleTerms = Number(this.controls.termsRange.value);
    this.controls.termsValue.value = String(this.state.visibleTerms);
    this.recalcLayout();
    this.state.trace = [];
  }

  handleSpeedChange() {
    this.state.speed = mapUiSpeedToInternal(Number(this.controls.speedRange.value));
    this.controls.speedValue.value = String(Number(this.controls.speedRange.value));
  }

  handlePauseToggle() {
    this.state.isPaused = !this.state.isPaused;
    this.controls.pauseButton.textContent = this.state.isPaused ? "Resume" : "Pause";
    this.controls.pauseButton.setAttribute("aria-pressed", this.state.isPaused ? "true" : "false");
  }

  handleTraceReset() {
    this.state.trace = [];
    this.state.phase = 0;
    this.setStatus("");
  }

  handleKeydown(event) {
    if (!event.altKey || event.repeat) {
      return;
    }

    if (event.key.toLowerCase() === "d") {
      event.preventDefault();
      this.state.showBridgeDebug = !this.state.showBridgeDebug;
      this.setStatus(
        this.state.showBridgeDebug
          ? "Bridge debug ON (red = pen-up bridge travel)."
          : "Bridge debug OFF.",
      );
    }
  }

  bindUI() {
    this.document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.document.addEventListener("keydown", this.handleKeydown);
    this.controls.themeToggle.addEventListener("change", () => this.handleThemeToggle());
    this.controls.sourceModeInputs.forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.switchSourceMode(input.value);
        }
      });
    });
    this.controls.fileInput.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      this.handleFileUpload(file);
    });
    this.controls.sampleStarButton.addEventListener("click", () => {
      this.handleSampleStar();
    });
    this.controls.clearDrawButton.addEventListener("click", () => this.handleClearDrawing());
    this.controls.acceptDrawButton.addEventListener("click", () => this.handleAcceptDrawing());
    this.controls.termsRange.addEventListener("input", () => this.handleTermsChange());
    this.controls.speedRange.addEventListener("input", () => this.handleSpeedChange());
    this.controls.pauseButton.addEventListener("click", () => this.handlePauseToggle());
    this.controls.resetTraceButton.addEventListener("click", () => this.handleTraceReset());
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
  }

  initCanvasSizeHandling() {
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        this.canvas.width = Math.round(width);
        this.canvas.height = Math.round(height);
        this.recalcLayout();
        this.state.trace = [];
        if (this.state.sourceMode === "draw" && this.state.drawPreviewPoints.length > 0) {
          this.state.drawPreviewPoints = [];
        }
      }
    });

    resizeObserver.observe(this.canvas);

    const initialRect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(initialRect.width) || 800;
    this.canvas.height = Math.round(initialRect.height) || 600;
    this.recalcLayout();
  }
}
