export const clampZoom = z => Math.max(.2, Math.min(2.5, z));
export function zoomAt(view, point, nextZoom) {
  const zoom = clampZoom(nextZoom), ratio = zoom / view.zoom;
  return {x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio, zoom};
}
export function fitBounds(bounds, size, padding = 32) {
  const zoom = clampZoom(Math.min(1, Math.max(1, size.width - padding * 2) / Math.max(1, bounds.width),
    Math.max(1, size.height - padding * 2) / Math.max(1, bounds.height)));
  return {x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom};
}
export function freshCanvas() { return {view:{x:20,y:20,zoom:.85}, positions:{}}; }
export function readCanvas(raw) {
  const state = freshCanvas();
  try {
    const data = JSON.parse(raw);
    if (data?.view && ['x','y','zoom'].every(k => Number.isFinite(data.view[k])) && data.view.zoom > 0)
      state.view = {...data.view, zoom:clampZoom(data.view.zoom)};
    for (const [id, p] of Object.entries(data?.positions || {}))
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) state.positions[id] = {x:p.x,y:p.y};
  } catch { /* A missing or damaged preference must never block the manuscript. */ }
  return state;
}
