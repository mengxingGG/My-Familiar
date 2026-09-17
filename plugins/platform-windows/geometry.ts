export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function clampRect(rect: Rect, areas: Rect[]): Rect {
  if (!areas.length) return rect;
  const area =
    areas.find(
      (a) =>
        rect.x + rect.width / 2 >= a.x &&
        rect.x + rect.width / 2 <= a.x + a.width &&
        rect.y + rect.height / 2 >= a.y &&
        rect.y + rect.height / 2 <= a.y + a.height,
    ) ??
    areas.reduce((best, a) =>
      Math.hypot(rect.x - a.x, rect.y - a.y) <
      Math.hypot(rect.x - best.x, rect.y - best.y)
        ? a
        : best,
    );
  return {
    ...rect,
    x: Math.round(
      Math.max(area.x, Math.min(rect.x, area.x + area.width - rect.width)),
    ),
    y: Math.round(
      Math.max(area.y, Math.min(rect.y, area.y + area.height - rect.height)),
    ),
  };
}
