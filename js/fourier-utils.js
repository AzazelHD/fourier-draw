import {
  EDGE_BASE_GAP,
  SPEED_INTERNAL_MAX,
  SPEED_INTERNAL_MIN,
  SPEED_UI_MAX,
  SPEED_UI_MIN,
} from "./config.js";

export function mapUiSpeedToInternal(uiValue) {
  const clamped = Math.min(SPEED_UI_MAX, Math.max(SPEED_UI_MIN, uiValue));
  const ratio = (clamped - SPEED_UI_MIN) / (SPEED_UI_MAX - SPEED_UI_MIN);
  return SPEED_INTERNAL_MIN + ratio * (SPEED_INTERNAL_MAX - SPEED_INTERNAL_MIN);
}

export function getDominantRadius(series, limit) {
  if (!series.length) {
    return 0.58;
  }

  const terms = series.slice(0, Math.max(1, limit));
  const main = terms[0]?.amplitude ?? 0;
  const next = terms[1]?.amplitude ?? 0;
  return main + next * 0.5;
}

export function computeFourierSeries(values) {
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

export function evaluateSeries(coefficients, angle, limit) {
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

export function normalizePoints(points) {
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

export function resamplePolyline(points, sampleCount, closed = true) {
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

function parsePointsAttribute(pointsAttr) {
  return pointsAttr
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number))
    .filter((pair) => pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
    .map(([x, y]) => ({ x, y }));
}

export function parseSvgPoints(svgText, sampleCount) {
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

  const tagName = shape.tagName.toLowerCase();

  if (tagName === "path") {
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

  if (tagName === "polygon" || tagName === "polyline") {
    const rawPoints = parsePointsAttribute(shape.getAttribute("points") || "");

    if (rawPoints.length < 2) {
      throw new Error("Shape has too few points.");
    }

    return resamplePolyline(rawPoints, sampleCount, tagName === "polygon");
  }

  if (tagName === "rect") {
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

  if (tagName === "line") {
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

  if (tagName === "circle" || tagName === "ellipse") {
    const cx = Number(shape.getAttribute("cx") || 0);
    const cy = Number(shape.getAttribute("cy") || 0);
    const rx =
      tagName === "circle"
        ? Number(shape.getAttribute("r") || 0)
        : Number(shape.getAttribute("rx") || 0);
    const ry =
      tagName === "circle"
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

export function getSafeScale(layout, xSeries, ySeries, visibleTerms, drawScale) {
  if (!xSeries.length || !ySeries.length) {
    return drawScale;
  }

  const xDominantRadius = getDominantRadius(xSeries, visibleTerms);
  const yDominantRadius = getDominantRadius(ySeries, visibleTerms);
  const dominantRadius = Math.max(xDominantRadius, yDominantRadius);

  if (dominantRadius <= 0) {
    return drawScale;
  }

  const topFitScale = Math.max(4, layout.topCenterY - EDGE_BASE_GAP) / xDominantRadius;
  const leftFitScale = Math.max(4, layout.leftCenterX - EDGE_BASE_GAP) / yDominantRadius;
  return Math.min(drawScale, topFitScale, leftFitScale);
}
