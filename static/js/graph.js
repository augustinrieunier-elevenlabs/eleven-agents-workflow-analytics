// Interactive workflow canvas: zoom, pan, and node dragging.
//
// The graph markup is rendered as a string by screens/workflow.js; this module
// attaches behaviour to whatever is in the DOM after each render. During an
// interaction it mutates the DOM directly rather than re-rendering, so dragging
// a node stays smooth on a graph with dozens of nodes.
//
// Node positions are a display concern, not API data — they are persisted
// separately from the response cache (see layouts.py).

import { NODE_H, NODE_W } from './derive.js';

// Low enough that "Fit" can actually fit a sprawling graph. A 40-node graph
// spanning ~9,500px needs roughly 0.09 to fit a 900px viewport, so clamping at
// 0.2 left it clipped — which was the whole complaint.
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 2.5;
const DRAG_THRESHOLD = 4;

/** The edge curve. Shared with the initial render so drags match exactly. */
export function edgePath(ax, ay, bx, by) {
  const x1 = ax + NODE_W;
  const y1 = ay + NODE_H / 2;
  const x2 = bx;
  const y2 = by + NODE_H / 2;
  const dx = Math.max(34, (x2 - x1) * 0.5);
  return `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`;
}

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Zoom and offset that fit every node into the viewport, with a margin. */
export function fitView(nodes, viewportW, viewportH, margin = 32) {
  if (!nodes.length || !viewportW || !viewportH) return { zoom: 1, x: 0, y: 0 };
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + NODE_W));
  const maxY = Math.max(...nodes.map((n) => n.y + NODE_H));
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const ideal = Math.min((viewportW - margin * 2) / w, (viewportH - margin * 2) / h, MAX_ZOOM);
  const zoom = clampZoom(ideal);
  // If even the minimum zoom cannot fit the graph, anchor the top-left rather
  // than centring — otherwise the start of the flow sits off-screen and the
  // user has to hunt for it by panning.
  if (zoom > ideal + 1e-9) {
    return { zoom, x: margin - minX * zoom, y: margin - minY * zoom };
  }
  return {
    zoom,
    x: (viewportW - w * zoom) / 2 - minX * zoom,
    y: (viewportH - h * zoom) / 2 - minY * zoom,
  };
}

let detach = null;

/**
 * Bind the canvas in the current DOM.
 *
 * @param handlers.onLayout  (nodes, view) => void — committed changes, debounced by the caller
 * @param handlers.onOpen    (nodeId) => void      — a click that was not a drag
 */
export function attachGraph(handlers = {}) {
  if (detach) { detach(); detach = null; }

  const wrap = document.getElementById('cvs-wrap');
  const inner = document.getElementById('cvs');
  if (!wrap || !inner) return;

  const nodeEls = Array.from(inner.querySelectorAll('[data-node-id]'));
  const edgeEls = Array.from(inner.querySelectorAll('[data-edge]'));

  const pos = new Map();
  for (const el of nodeEls) {
    pos.set(el.dataset.nodeId, { x: Number(el.dataset.x) || 0, y: Number(el.dataset.y) || 0 });
  }

  const view = {
    zoom: Number(inner.dataset.zoom) || 1,
    x: Number(inner.dataset.panX) || 0,
    y: Number(inner.dataset.panY) || 0,
  };

  const applyView = () => {
    inner.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const label = wrap.querySelector('[data-zoom-label]');
    if (label) label.textContent = Math.round(view.zoom * 100) + '%';
  };

  const redrawEdges = (movedId) => {
    for (const el of edgeEls) {
      const { source, target } = el.dataset;
      if (movedId && source !== movedId && target !== movedId) continue;
      const a = pos.get(source);
      const b = pos.get(target);
      if (!a || !b) continue;
      el.setAttribute('d', edgePath(a.x, a.y, b.x, b.y));
      const dot = inner.querySelector(`[data-edge-dot="${el.dataset.edge}"]`);
      if (dot) {
        dot.setAttribute('cx', String(b.x - 3));
        dot.setAttribute('cy', String(b.y + NODE_H / 2));
      }
      const text = inner.querySelector(`[data-edge-label="${el.dataset.edge}"]`);
      if (text) {
        text.setAttribute('x', String((a.x + NODE_W + b.x) / 2));
        text.setAttribute('y', String((a.y + b.y) / 2 + NODE_H / 2 - 6));
      }
    }
  };

  const commit = () => {
    if (!handlers.onLayout) return;
    const out = {};
    for (const [id, p] of pos.entries()) out[id] = { x: Math.round(p.x), y: Math.round(p.y) };
    handlers.onLayout(out, { zoom: view.zoom, x: Math.round(view.x), y: Math.round(view.y) });
  };

  // ── zoom ────────────────────────────────────────────────────────────

  /** Zoom about a point in viewport coordinates, so that point stays put. */
  const zoomAt = (factor, clientX, clientY) => {
    const rect = wrap.getBoundingClientRect();
    const px = (clientX == null ? rect.width / 2 : clientX - rect.left);
    const py = (clientY == null ? rect.height / 2 : clientY - rect.top);
    const next = clampZoom(view.zoom * factor);
    if (next === view.zoom) return;
    const k = next / view.zoom;
    view.x = px - (px - view.x) * k;
    view.y = py - (py - view.y) * k;
    view.zoom = next;
    applyView();
  };

  const onWheel = (event) => {
    // Trackpad pinch arrives as ctrl+wheel; a plain wheel also zooms here
    // because the canvas owns the whole viewport and has nothing to scroll.
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(factor, event.clientX, event.clientY);
    scheduleCommit();
  };

  // ── pointer: pan the background, drag a node ────────────────────────

  let mode = null;          // 'pan' | 'node'
  let moved = false;
  let startClient = { x: 0, y: 0 };
  let startView = { x: 0, y: 0 };
  let dragEl = null;
  let dragId = null;
  let dragStart = { x: 0, y: 0 };

  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    const nodeEl = event.target.closest('[data-node-id]');
    moved = false;
    startClient = { x: event.clientX, y: event.clientY };

    if (nodeEl) {
      mode = 'node';
      dragEl = nodeEl;
      dragId = nodeEl.dataset.nodeId;
      const p = pos.get(dragId);
      dragStart = { x: p.x, y: p.y };
    } else {
      mode = 'pan';
      startView = { x: view.x, y: view.y };
      wrap.classList.add('is-panning');
    }
    wrap.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!mode) return;
    const dx = event.clientX - startClient.x;
    const dy = event.clientY - startClient.y;
    if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!moved) {
      moved = true;
      if (mode === 'node') dragEl.classList.add('is-dragging');
    }

    if (mode === 'pan') {
      view.x = startView.x + dx;
      view.y = startView.y + dy;
      applyView();
      return;
    }

    // Pointer delta is in screen pixels; node coordinates are unscaled.
    const nx = dragStart.x + dx / view.zoom;
    const ny = dragStart.y + dy / view.zoom;
    pos.set(dragId, { x: nx, y: ny });
    dragEl.style.left = nx + 'px';
    dragEl.style.top = ny + 'px';
    dragEl.dataset.x = String(nx);
    dragEl.dataset.y = String(ny);
    redrawEdges(dragId);
  };

  const onPointerUp = (event) => {
    if (!mode) return;
    const wasNode = mode === 'node';
    const didMove = moved;
    if (dragEl) dragEl.classList.remove('is-dragging');
    wrap.classList.remove('is-panning');
    try { wrap.releasePointerCapture(event.pointerId); } catch (e) { /* already gone */ }
    mode = null;
    dragEl = null;

    if (didMove) {
      suppressClickUntil = Date.now() + 250;
      commit();
    } else if (wasNode && handlers.onOpen) {
      handlers.onOpen(dragId);
    }
    dragId = null;
  };

  // A drag ends with a click event on the node; swallow it so the drawer does
  // not open every time a node is repositioned.
  let suppressClickUntil = 0;
  const onClickCapture = (event) => {
    if (Date.now() < suppressClickUntil) {
      event.stopPropagation();
      event.preventDefault();
    }
  };

  // ── controls ────────────────────────────────────────────────────────

  const onToolClick = (event) => {
    const btn = event.target.closest('[data-zoom]');
    if (!btn) return;
    event.stopPropagation();
    const action = btn.dataset.zoom;
    if (action === 'in') zoomAt(1.25, null, null);
    else if (action === 'out') zoomAt(1 / 1.25, null, null);
    else if (action === 'reset') { view.zoom = 1; view.x = 0; view.y = 0; applyView(); }
    else if (action === 'fit') {
      const rect = wrap.getBoundingClientRect();
      const fitted = fitView(Array.from(pos.values()), rect.width, rect.height);
      view.zoom = fitted.zoom; view.x = fitted.x; view.y = fitted.y;
      applyView();
    }
    commit();
  };

  let commitTimer = null;
  const scheduleCommit = () => {
    clearTimeout(commitTimer);
    commitTimer = setTimeout(commit, 400);
  };

  wrap.addEventListener('wheel', onWheel, { passive: false });
  wrap.addEventListener('pointerdown', onPointerDown);
  wrap.addEventListener('pointermove', onPointerMove);
  wrap.addEventListener('pointerup', onPointerUp);
  wrap.addEventListener('pointercancel', onPointerUp);
  wrap.addEventListener('click', onClickCapture, true);
  wrap.addEventListener('click', onToolClick);

  applyView();

  detach = () => {
    clearTimeout(commitTimer);
    wrap.removeEventListener('wheel', onWheel);
    wrap.removeEventListener('pointerdown', onPointerDown);
    wrap.removeEventListener('pointermove', onPointerMove);
    wrap.removeEventListener('pointerup', onPointerUp);
    wrap.removeEventListener('pointercancel', onPointerUp);
    wrap.removeEventListener('click', onClickCapture, true);
    wrap.removeEventListener('click', onToolClick);
  };
}

export function detachGraph() {
  if (detach) { detach(); detach = null; }
}
