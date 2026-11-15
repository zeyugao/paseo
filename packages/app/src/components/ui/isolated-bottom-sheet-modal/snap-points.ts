export function resolveSheetSnapPoint(
  point: number | string,
  containerHeight: number,
  topInset: number,
  bottomInset = 0,
): number | string {
  "worklet";
  // Gorhom defers percentage normalization until the host has been measured.
  if (typeof point === "number" || containerHeight < 0) return point;
  const availableHeight = containerHeight - topInset - bottomInset;
  const clearanceFraction = 1 - Number.parseFloat(point) / 100;
  const topClearance = Math.max(topInset, availableHeight * clearanceFraction);
  return containerHeight - bottomInset - topClearance;
}
