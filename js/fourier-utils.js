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

function samplePathData(pathData, sampleCount) {
  const tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tempPath.setAttribute("d", pathData);
  const totalLength = tempPath.getTotalLength();

  if (!Number.isFinite(totalLength) || totalLength <= 0) {
    return { points: [], totalLength: 0 };
  }

  const sampled = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const point = tempPath.getPointAtLength((index / sampleCount) * totalLength);
    sampled.push({ x: point.x, y: point.y });
  }

  return { points: sampled, totalLength };
}

function getPathLength(pathData) {
  const tempPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tempPath.setAttribute("d", pathData);
  const totalLength = tempPath.getTotalLength();
  return Number.isFinite(totalLength) ? totalLength : 0;
}

function splitPathDataIntoSubpaths(pathData) {
  // Split on moveto commands; each moveto starts a new independent contour.
  return pathData
    .trim()
    .split(/(?=[Mm])/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveSvgSampleBudget(lengths, sampleCount) {
  if (Number.isFinite(sampleCount) && sampleCount > 0) {
    return Math.max(16, Math.floor(sampleCount));
  }

  const totalLength = lengths.reduce((sum, value) => sum + value, 0);
  const contourCount = Math.max(1, lengths.length);

  // Auto budget when caller does not provide one.
  // It scales by path length and contour count, then clamps for performance.
  const byLength = Math.round(totalLength / 14);
  const byContourCount = contourCount * 220;
  return Math.max(240, Math.min(6000, Math.max(byLength, byContourCount)));
}

function allocateContourSamples(lengths, sampleCount) {
  if (!lengths.length || sampleCount <= 0) {
    return [];
  }

  const totalLength = lengths.reduce((sum, value) => sum + value, 0);
  if (totalLength <= 0) {
    return [];
  }

  const contourCount = lengths.length;
  const minSamplesPerContour = Math.max(1, Math.min(8, Math.floor(sampleCount / contourCount)));

  const rawCounts = lengths.map((length) => (length / totalLength) * sampleCount);
  const counts = rawCounts.map((raw) => Math.max(minSamplesPerContour, Math.floor(raw)));

  let assigned = counts.reduce((sum, count) => sum + count, 0);
  const order = rawCounts
    .map((raw, index) => ({ index, remainder: raw - Math.floor(raw) }))
    .sort((left, right) => right.remainder - left.remainder);

  let orderIndex = 0;
  while (assigned < sampleCount && order.length > 0) {
    const targetIndex = order[orderIndex % order.length].index;
    counts[targetIndex] += 1;
    assigned += 1;
    orderIndex += 1;
  }

  while (assigned > sampleCount) {
    const targetIndex = counts.indexOf(Math.max(...counts));
    if (targetIndex < 0 || counts[targetIndex] <= minSamplesPerContour) {
      break;
    }
    counts[targetIndex] -= 1;
    assigned -= 1;
  }

  return counts;
}

function parseSvgTransformToMatrix(transformStr) {
  if (!transformStr) {
    return null;
  }
  const matrix = new DOMMatrix();
  const regex = /(translate|scale|rotate|matrix|skewX|skewY)\s*\(([^)]+)\)/gi;
  let match;
  while ((match = regex.exec(transformStr)) !== null) {
    const type = match[1].toLowerCase();
    const values = match[2].split(/[\s,]+/).map(Number);
    switch (type) {
      case "translate":
        matrix.translateSelf(values[0] || 0, values[1] || 0);
        break;
      case "scale":
        matrix.scaleSelf(values[0] ?? 1, values.length > 1 ? values[1] : (values[0] ?? 1));
        break;
      case "rotate":
        if (values.length >= 3) {
          matrix.translateSelf(values[1], values[2]);
          matrix.rotateSelf(values[0]);
          matrix.translateSelf(-values[1], -values[2]);
        } else {
          matrix.rotateSelf(values[0] || 0);
        }
        break;
      case "matrix":
        matrix.multiplySelf(
          new DOMMatrix([values[0], values[1], values[2], values[3], values[4], values[5]]),
        );
        break;
      case "skewx":
        matrix.skewXSelf(values[0] || 0);
        break;
      case "skewy":
        matrix.skewYSelf(values[0] || 0);
        break;
    }
  }
  return matrix;
}

function getElementTransform(element) {
  const transforms = [];
  let current = element;
  while (current && current.nodeType === 1) {
    if (current.tagName?.toLowerCase() === "svg") {
      break;
    }
    const attr = current.getAttribute("transform");
    if (attr) {
      transforms.unshift(attr);
    }
    current = current.parentElement;
  }
  if (!transforms.length) {
    return null;
  }
  let matrix = new DOMMatrix();
  for (const str of transforms) {
    const parsed = parseSvgTransformToMatrix(str);
    if (parsed) {
      matrix = matrix.multiply(parsed);
    }
  }
  return matrix;
}

function applyTransform(matrix, points) {
  if (!matrix) {
    return points;
  }
  return points.map((p) => ({
    x: matrix.a * p.x + matrix.c * p.y + matrix.e,
    y: matrix.b * p.x + matrix.d * p.y + matrix.f,
  }));
}

function polylineArcLength(points, closed) {
  if (points.length < 2) {
    return 0;
  }
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  if (closed && points.length > 1) {
    length += Math.hypot(
      points[0].x - points[points.length - 1].x,
      points[0].y - points[points.length - 1].y,
    );
  }
  return length;
}

function findNearestPointIndex(points, target) {
  let bestDistance = Infinity;
  let bestIndex = 0;
  for (let i = 0; i < points.length; i += 1) {
    const d = Math.hypot(points[i].x - target.x, points[i].y - target.y);
    if (d < bestDistance) {
      bestDistance = d;
      bestIndex = i;
    }
  }
  return { index: bestIndex, distance: bestDistance };
}

function bridgeContours(contours) {
  if (contours.length === 0) {
    return [];
  }
  if (contours.length === 1) {
    return contours[0].points;
  }
  const count = contours.length;
  const visited = new Array(count).fill(false);
  const points = contours.map((c) => [...c.points]);
  visited[0] = true;
  const order = [0];
  for (let step = 1; step < count; step += 1) {
    const prevPoints = points[order[order.length - 1]];
    const exitPoint = prevPoints[prevPoints.length - 1];
    let bestContour = -1;
    let bestPointIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i += 1) {
      if (visited[i]) {
        continue;
      }
      const { index, distance } = findNearestPointIndex(points[i], exitPoint);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestContour = i;
        bestPointIndex = index;
      }
    }
    if (bestContour < 0) {
      break;
    }
    if (contours[bestContour].isClosed && bestPointIndex > 0) {
      points[bestContour] = [
        ...points[bestContour].slice(bestPointIndex),
        ...points[bestContour].slice(0, bestPointIndex),
      ];
    }
    visited[bestContour] = true;
    order.push(bestContour);
  }
  const result = [];
  for (const idx of order) {
    result.push(...points[idx]);
  }
  return result;
}

function orderContours(contours) {
  if (contours.length === 0) {
    return [];
  }
  if (contours.length === 1) {
    return [{ points: [...contours[0].points], isClosed: contours[0].isClosed }];
  }

  const count = contours.length;
  const visited = new Array(count).fill(false);
  const points = contours.map((c) => [...c.points]);
  visited[0] = true;
  const order = [0];

  for (let step = 1; step < count; step += 1) {
    const prevPoints = points[order[order.length - 1]];
    const exitPoint = prevPoints[prevPoints.length - 1];
    let bestContour = -1;
    let bestPointIndex = 0;
    let bestDistance = Infinity;

    for (let i = 0; i < count; i += 1) {
      if (visited[i]) {
        continue;
      }
      const { index, distance } = findNearestPointIndex(points[i], exitPoint);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestContour = i;
        bestPointIndex = index;
      }
    }

    if (bestContour < 0) {
      break;
    }

    if (contours[bestContour].isClosed && bestPointIndex > 0) {
      points[bestContour] = [
        ...points[bestContour].slice(bestPointIndex),
        ...points[bestContour].slice(0, bestPointIndex),
      ];
    }

    visited[bestContour] = true;
    order.push(bestContour);
  }

  return order.map((idx) => ({ points: points[idx], isClosed: contours[idx].isClosed }));
}

function buildSegmentsFromContours(orderedContours) {
  const segments = [];

  if (!orderedContours.length) {
    return segments;
  }

  for (let contourIndex = 0; contourIndex < orderedContours.length; contourIndex += 1) {
    const contour = orderedContours[contourIndex];
    const pts = contour.points;

    if (pts.length < 2) {
      continue;
    }

    for (let i = 1; i < pts.length; i += 1) {
      const start = pts[i - 1];
      const end = pts[i];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length > 0.0001) {
        segments.push({ start, end, length, draw: true });
      }
    }

    if (contour.isClosed) {
      const start = pts[pts.length - 1];
      const end = pts[0];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length > 0.0001) {
        segments.push({ start, end, length, draw: true });
      }
    }

    const nextContour = orderedContours[contourIndex + 1];
    if (!nextContour || nextContour.points.length === 0) {
      continue;
    }

    // Keep chain continuity: if contour is closed, traversal ends at pts[0] after close segment.
    const start = contour.isClosed ? pts[0] : pts[pts.length - 1];
    const end = nextContour.points[0];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length > 0.0001) {
      segments.push({ start, end, length, draw: false });
    }
  }

  return segments;
}

function resampleSegmentsWithMask(segments, sampleCount) {
  if (!segments.length || sampleCount <= 0) {
    return { points: [], drawMask: [] };
  }

  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (totalLength <= 0) {
    return { points: [], drawMask: [] };
  }

  const chain = [];
  let offset = 0;
  for (const segment of segments) {
    chain.push({ ...segment, offset });
    offset += segment.length;
  }

  const points = [];
  const drawMask = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const distance = (index / sampleCount) * totalLength;
    const segment =
      chain.find((entry) => distance <= entry.offset + entry.length) || chain[chain.length - 1];
    const localDistance = distance - segment.offset;
    const ratio = segment.length === 0 ? 0 : localDistance / segment.length;

    points.push({
      x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
      y: segment.start.y + (segment.end.y - segment.start.y) * ratio,
    });
    drawMask.push(Boolean(segment.draw));
  }

  return { points, drawMask };
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

  const shapes = Array.from(
    rootSvg.querySelectorAll("path, polygon, polyline, rect, circle, ellipse, line"),
  );
  if (!shapes.length) {
    throw new Error(
      "No compatible shape found. Use path, polygon, polyline, rect, circle, ellipse, or line.",
    );
  }

  // Collect all contours from every shape element.
  const allCandidates = [];

  for (const shape of shapes) {
    const tagName = shape.tagName.toLowerCase();
    const transform = getElementTransform(shape);

    if (tagName === "path") {
      const pathData = shape.getAttribute("d");
      if (!pathData) {
        continue;
      }

      const subpaths = splitPathDataIntoSubpaths(pathData);
      for (const piece of subpaths) {
        const length = getPathLength(piece);
        if (length > 0) {
          allCandidates.push({ pathData: piece, length, isClosed: /[zZ]/.test(piece), transform });
        }
      }
      continue;
    }

    if (tagName === "polygon" || tagName === "polyline") {
      const rawPoints = parsePointsAttribute(shape.getAttribute("points") || "");
      if (rawPoints.length >= 2) {
        const isClosed = tagName === "polygon";
        const pts = resamplePolyline(rawPoints, 64, isClosed);
        if (pts.length) {
          allCandidates.push({
            presampled: pts,
            length: polylineArcLength(pts, isClosed),
            isClosed,
            transform,
          });
        }
      }
      continue;
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
      const pts = resamplePolyline(corners, 64, true);
      if (pts.length) {
        allCandidates.push({
          presampled: pts,
          length: 2 * (width + height),
          isClosed: true,
          transform,
        });
      }
      continue;
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
      const pts = [];
      for (let i = 0; i < 64; i += 1) {
        const angle = (2 * Math.PI * i) / 64;
        pts.push({ x: cx + rx * Math.cos(angle), y: cy + ry * Math.sin(angle) });
      }
      allCandidates.push({
        presampled: pts,
        length: 2 * Math.PI * Math.max(rx, ry),
        isClosed: true,
        transform,
      });
      continue;
    }

    if (tagName === "line") {
      const x1 = Number(shape.getAttribute("x1") || 0);
      const y1 = Number(shape.getAttribute("y1") || 0);
      const x2 = Number(shape.getAttribute("x2") || 0);
      const y2 = Number(shape.getAttribute("y2") || 0);
      const pts = resamplePolyline(
        [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ],
        16,
        false,
      );
      if (pts.length) {
        allCandidates.push({
          presampled: pts,
          length: Math.hypot(x2 - x1, y2 - y1),
          isClosed: false,
          transform,
        });
      }
      continue;
    }
  }

  if (!allCandidates.length) {
    throw new Error("No usable paths found in the SVG.");
  }

  allCandidates.sort((left, right) => right.length - left.length);
  const selected = allCandidates.slice(0, 128);
  const sampleBudget = resolveSvgSampleBudget(
    selected.map((entry) => entry.length),
    sampleCount,
  );

  // Single contour: sample directly
  if (selected.length === 1) {
    const contour = selected[0];
    let pts;
    if (contour.presampled) {
      pts = contour.presampled;
    } else {
      pts = samplePathData(contour.pathData, sampleBudget).points;
    }
    pts = applyTransform(contour.transform, pts);
    if (!pts.length) {
      throw new Error("Could not sample any path from the SVG.");
    }
    return {
      points: pts,
      isClosed: contour.isClosed,
      drawMask: new Array(pts.length).fill(true),
      referenceContours: [{ points: pts, isClosed: contour.isClosed }],
    };
  }

  // Multiple contours: oversample, transform, bridge, resample
  const oversampleTotal = sampleBudget * 2;
  const sampleCounts = allocateContourSamples(
    selected.map((entry) => entry.length),
    oversampleTotal,
  );

  const sampledContours = [];
  for (let index = 0; index < selected.length; index += 1) {
    const targetSamples = Math.max(1, sampleCounts[index] || 0);
    let pts;
    if (selected[index].presampled) {
      pts = selected[index].presampled;
    } else {
      pts = samplePathData(selected[index].pathData, targetSamples).points;
    }
    if (!pts.length) {
      continue;
    }
    pts = applyTransform(selected[index].transform, pts);
    sampledContours.push({ points: pts, isClosed: selected[index].isClosed });
  }

  if (!sampledContours.length) {
    throw new Error("Could not sample any path from the SVG.");
  }

  if (sampledContours.length === 1) {
    const finalPoints = resamplePolyline(
      sampledContours[0].points,
      sampleBudget,
      sampledContours[0].isClosed,
    );
    return {
      points: finalPoints,
      isClosed: sampledContours[0].isClosed,
      drawMask: new Array(finalPoints.length).fill(true),
      referenceContours: [
        {
          points: sampledContours[0].points,
          isClosed: sampledContours[0].isClosed,
        },
      ],
    };
  }

  const orderedContours = orderContours(sampledContours);
  const segments = buildSegmentsFromContours(orderedContours);
  const { points: finalPoints, drawMask } = resampleSegmentsWithMask(segments, sampleBudget);

  if (!finalPoints.length) {
    throw new Error("Could not sample any path from the SVG.");
  }

  return {
    points: finalPoints,
    isClosed: false,
    drawMask,
    referenceContours: orderedContours,
  };
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
