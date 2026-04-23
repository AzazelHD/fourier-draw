import { EDGE_BASE_GAP } from "./config.js";

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

export function getSafeScale(layout, xSeries, ySeries, visibleTerms, drawScale) {
  if (!xSeries.length || !ySeries.length) {
    return drawScale;
  }

  const xDominantRadius = getDominantRadius(xSeries, visibleTerms);
  const yDominantRadius = getDominantRadius(ySeries, visibleTerms);

  if (xDominantRadius <= 0 || yDominantRadius <= 0) {
    return drawScale;
  }

  const topFitScale = Math.max(4, layout.topCenterY - EDGE_BASE_GAP) / xDominantRadius;
  const leftFitScale = Math.max(4, layout.leftCenterX - EDGE_BASE_GAP) / yDominantRadius;
  return Math.min(drawScale, topFitScale, leftFitScale);
}
