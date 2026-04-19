import {
  DRAW_SCALE_FACTOR,
  EDGE_BASE_GAP,
  EDGE_EXTRA_GAP,
  FRAME_PADDING,
  MAX_LEFT_MARGIN_RATIO,
  MAX_SVG_SIZE_BYTES,
  MAX_TOP_MARGIN_RATIO,
  MIN_LEFT_MARGIN,
  MIN_TOP_MARGIN,
  SAMPLE_COUNT,
  STAR_SVG,
  STORAGE_THEME_KEY,
  TRAIL_RATIO,
} from "./config.js";
import {
  computeFourierSeries,
  evaluateSeries,
  getDominantRadius,
  getSafeScale,
  mapUiSpeedToInternal,
  normalizePoints,
  parseSvgPoints,
  resamplePolyline,
} from "./fourier-utils.js";

export class FourierApp {
  constructor(documentRef) {
    this.document = documentRef;
    this.canvas = documentRef.getElementById("fourier-canvas");
    this.context = this.canvas.getContext("2d");
    this.body = documentRef.body;
    this.controls = {
      themeToggle: documentRef.getElementById("theme-toggle"),
      sourceModeInputs: documentRef.querySelectorAll('input[name="source-mode"]'),
      svgFileInput: documentRef.getElementById("svg-file"),
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
      xSeries: [],
      ySeries: [],
      trace: [],
      visibleTerms: Number(this.controls.termsRange.value),
      speed: mapUiSpeedToInternal(Number(this.controls.speedRange.value)),
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
      line: "#ffffff",
    };

    this.animationLoop = this.animationLoop.bind(this);
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
    this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
  }

  init() {
    const storedTheme = localStorage.getItem(STORAGE_THEME_KEY);
    this.setTheme(storedTheme || "dark");
    this.controls.speedValue.value = String(Number(this.controls.speedRange.value));
    this.bindUI();
    this.initCanvasSizeHandling();
    this.loadDefaultStar();
    requestAnimationFrame(this.animationLoop);
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
    this.layout.topCenterY = Math.round(topMargin / 2);
    this.layout.leftCenterX = Math.round(leftMargin / 2);
  }

  getCanvasPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((event.clientY - rect.top) / rect.height) * this.canvas.height;
    return { x, y };
  }

  buildSeriesFromPoints(points, message) {
    const normalized = normalizePoints(points);
    if (normalized.length < 10) {
      this.setStatus("Not enough points to compute Fourier.");
      return;
    }

    this.state.normalizedPoints = normalized;
    this.state.xSeries = computeFourierSeries(normalized.map((point) => point.x));
    this.state.ySeries = computeFourierSeries(normalized.map((point) => point.y));
    this.recalcLayout();
    this.state.trace = [];
    this.state.phase = 0;
    this.setStatus(message);
  }

  loadDefaultStar() {
    const sampled = parseSvgPoints(STAR_SVG, SAMPLE_COUNT);
    this.buildSeriesFromPoints(sampled, "");
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
    const fadeZone = 0.12;

    for (let index = 1; index < this.state.trace.length; index += 1) {
      const age = (this.state.phase - this.state.trace[index].phase + 1) % 1;
      const t = 1 - age / TRAIL_RATIO;
      this.context.globalAlpha = Math.min(1, t / fadeZone) * 0.95;
      this.context.strokeStyle = this.colors.line;
      this.context.beginPath();
      this.context.moveTo(this.state.trace[index - 1].x, this.state.trace[index - 1].y);
      this.context.lineTo(this.state.trace[index].x, this.state.trace[index].y);
      this.context.stroke();
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
      phase: this.state.phase,
    };

    this.state.trace.push(currentPoint);
    while (this.state.trace.length > 1) {
      const age = (this.state.phase - this.state.trace[0].phase + 1) % 1;
      if (age > TRAIL_RATIO) {
        this.state.trace.shift();
      } else {
        break;
      }
    }

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
      this.state.phase = (this.state.phase + deltaSeconds * this.state.speed) % 1;
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
    this.state.xSeries = [];
    this.state.ySeries = [];
    this.state.trace = [];
  }

  switchSourceMode(mode) {
    this.state.sourceMode = mode;
    const drawMode = mode === "draw";

    this.controls.svgFileInput.disabled = drawMode;
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
      this.setStatus("Draw mode active. Canvas is blank. Draw with your mouse.");
      return;
    }

    this.resetPendingDrawing();
    this.controls.acceptDrawButton.disabled = true;
    this.setStatus("SVG mode active.");
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

    this.state.pendingDrawSampledPoints = resamplePolyline(
      this.state.drawPoints,
      SAMPLE_COUNT,
      true,
    );
    this.controls.acceptDrawButton.disabled = this.state.pendingDrawSampledPoints.length === 0;

    if (this.state.pendingDrawSampledPoints.length > 0) {
      this.setStatus("Drawing ready. Click Accept.");
    }
  }

  async handleSvgUpload(file) {
    if (!file) {
      return;
    }

    if (file.type !== "image/svg+xml" && !file.name.toLowerCase().endsWith(".svg")) {
      this.setStatus("Invalid file. Please select an SVG.");
      this.controls.svgFileInput.value = "";
      return;
    }

    if (file.size > MAX_SVG_SIZE_BYTES) {
      this.setStatus("SVG is larger than 2 MB. Use a smaller file.");
      this.controls.svgFileInput.value = "";
      return;
    }

    try {
      const text = await file.text();
      const sampled = parseSvgPoints(text, SAMPLE_COUNT);
      this.buildSeriesFromPoints(sampled, `SVG loaded: ${file.name}`);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Could not read SVG.");
    }
  }

  handleVisibilityChange() {
    this.state.lastTimestamp = 0;
  }

  handleThemeToggle() {
    const nextTheme = this.controls.themeToggle.checked ? "dark" : "light";
    this.setTheme(nextTheme);
  }

  handleSampleStar() {
    this.switchSourceMode("upload");
    const uploadRadio = this.document.querySelector('input[name="source-mode"][value="upload"]');
    if (uploadRadio) {
      uploadRadio.checked = true;
    }
    this.loadDefaultStar();
  }

  handleClearDrawing() {
    if (this.state.sourceMode !== "draw") {
      return;
    }

    this.resetPendingDrawing();
    this.resetSeries();
    this.controls.acceptDrawButton.disabled = true;
    this.setStatus("Canvas cleared. Draw a new shape.");
  }

  handleAcceptDrawing() {
    if (this.state.sourceMode !== "draw" || this.state.pendingDrawSampledPoints.length === 0) {
      return;
    }

    this.buildSeriesFromPoints(this.state.pendingDrawSampledPoints, "");
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
    this.setStatus("Trace reset.");
  }

  bindUI() {
    this.document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.controls.themeToggle.addEventListener("change", () => this.handleThemeToggle());
    this.controls.sourceModeInputs.forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) {
          this.switchSourceMode(input.value);
        }
      });
    });
    this.controls.svgFileInput.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      this.handleSvgUpload(file);
    });
    this.controls.sampleStarButton.addEventListener("click", () => this.handleSampleStar());
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
