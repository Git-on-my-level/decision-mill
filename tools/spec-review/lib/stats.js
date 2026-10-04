// Small statistics shared by results.js and waves.js.

// Wilson score interval, 95%. Behaves at n small and p near 0/1, unlike p±1.96·se.
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

// Labels needed for a ±h interval at agreement p (normal approximation).
export const labelsFor = (p, h = 0.07) => Math.ceil((1.96 * 1.96 * Math.max(p * (1 - p), 0.05)) / (h * h));
