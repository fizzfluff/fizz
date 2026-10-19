// One dot per claimable cell: the lattice and the claim grid are the same.
// Cell (lat, lon) is the 1 degree square whose centre is (lat + 0.5, lon + 0.5).
export function buildLandCells(rings, step = 1) {
  const boxes = [];
  for (const ring of rings) {
    let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    boxes.push({ ring, minLon, maxLon, minLat, maxLat });
  }

  const inside = (ring, lon, lat) => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if ((yi > lat) !== (yj > lat) &&
          lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };

  const cells = [];
  for (let lat = -90; lat < 90; lat += step) {
    for (let lon = -180; lon < 180; lon += step) {
      const centerLat = lat + step / 2;
      const centerLon = lon + step / 2;
      for (const box of boxes) {
        if (centerLon < box.minLon || centerLon > box.maxLon ||
            centerLat < box.minLat || centerLat > box.maxLat) continue;
        if (inside(box.ring, centerLon, centerLat)) { cells.push({ lat, lon }); break; }
      }
    }
  }
  return cells;
}

// Brightness levels used to batch per-dot animation into a handful of fills.
export const GLOW_LEVELS = 12;

// A drifting world-space field: overlapping waves make moving patches of
// light. Each dot is sampled at its fixed spot on the sphere, so the pattern
// rides with the globe and the local phase shimmer slides patches around over
// time instead of pulsing from the screen centre.
export function dotBrightness(dot, timeSeconds, reduceMotion) {
  const x = dot.x ?? 0, y = dot.y ?? 0, z = dot.z ?? 0;
  const t = timeSeconds;
  const n =
    Math.sin(x * 8.3 + y * 4.6 + z * 3.4 + t * 1.0) +
    Math.sin(x * 5.8 - y * 7.4 + z * 4.2 - t * 0.85) +
    Math.sin(x * 3.4 + y * 8.6 - z * 6.2 + t * 1.15) +
    0.6 * Math.sin(x * 11 - y * 8 + z * 6 + t * 1.3);
  const v0 = Math.min(1, Math.max(0, 0.5 + n / 3.5));
  // Smoothstep pushes the middle toward black and white: readable patches.
  const v = v0 * v0 * (3 - 2 * v0);
  if (reduceMotion) {
    // Kept bright enough that no dot is ever swallowed, but the patches move.
    return 0.45 + 0.35 * v;
  }
  return v;
}

// A point on the unit sphere, used to sample the glow field.
function spherePoint(lat, lon) {
  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  return {
    x: Math.cos(latRad) * Math.sin(lonRad),
    y: Math.sin(latRad),
    z: Math.cos(latRad) * Math.cos(lonRad),
  };
}

// How far the brightest dots are lifted off the surface, as a fraction of the

// How far the brightest dots are lifted off the surface, as a fraction of the
// globe radius, and how much the noise shapes add on top.
const LIFT = 0.11;
const SPIKE_LIFT = 0.16;
const MAX_RELIEF = 0.20;

export class Globe {
  constructor(canvas, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    this.ui = ui;
    this.width = 0;
    this.height = 0;
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);

    this.projection = 'orthographic';
    this.centerLat = 0;
    this.centerLon = 0;
    this.targetCenterLat = 0;
    this.targetCenterLon = 0;
    this.scale = 1;
    this.targetScale = 1;
    this.centerX = 0;
    this.centerY = 0;

    this.landRings = [];
    this.hoveredCoord = null;
    this.selectedCoord = null;
    this.selectedMarker = null;
    this.isDragging = false;
    this.lastMouse = { x: 0, y: 0 };

    this.animationId = null;
    this.lastFrame = 0;
    this.targetFPS = 30;
    this.frameInterval = 1000 / this.targetFPS;
    this.glowTime = 0;
    this.reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.cells = new Map();
    this.recentActivity = [];

    this.bindEvents();
  }

  async init() {
    console.log('[init] resizing...');
    this.resize();
    window.addEventListener('resize', () => this.resize());
    try {
      console.log('[init] loading land data...');
      await this.loadLandData();
      console.log('[init] land data loaded, dots:', this.dots?.length);
      if (!this.dots || this.dots.length === 0) {
        throw new Error('land data produced no dots');
      }
    } catch (err) {
      this.fatal(err);
      return;
    }
    console.log('[init] starting render loop');
    this.startRenderLoop();
  }

  // A blank canvas is useless to debug, so paint the failure itself.
  fatal(err) {
    this.fatalError = err;
    console.error('[FIZZ MAP CHAT] render stopped:', err);
    const ctx = this.ctx;
    const { width, height } = this.getCanvasSize();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ff6b6b';
    ctx.font = '13px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('WORLD UNAVAILABLE', this.centerX, this.centerY - 10);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '11px ui-monospace, Consolas, monospace';
    const detail = String(err && err.message ? err.message : err).slice(0, 90);
    ctx.fillText(detail, this.centerX, this.centerY + 14);
    ctx.fillText('see console for the full error', this.centerX, this.centerY + 32);
  }

  async loadLandData() {
    console.log('[init] fetching land.geojson...');
    let res;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      res = await fetch('./land.geojson', { signal: controller.signal });
      clearTimeout(timeout);
      console.log('[init] land.geojson response:', res.status, res.ok, 'type:', res.type);
    } catch (e) {
      console.error('[init] fetch failed:', e.name, e.message);
      throw e;
    }
    console.log('[init] fetch completed, reading JSON...');
    let data;
    try {
      data = await res.json();
      console.log('[init] land.geojson parsed, features:', data.features?.length);
    } catch (e) {
      console.error('[init] json parse failed:', e);
      throw e;
    }
    try {
      this.landRings = this.buildRings(data.features);
      console.log('[init] landRings built:', this.landRings.length);
    } catch (e) {
      console.error('[init] buildRings failed:', e);
      throw e;
    }
    try {
      this.buildParticles();
      console.log('[init] particles built, dots:', this.dots.length, 'ocean:', this.oceanDots?.length);
    } catch (e) {
      console.error('[init] buildParticles failed:', e);
      throw e;
    }
  }

  buildParticles() {
    const cells = buildLandCells(this.landRings, 1);
    // Every land cell stays claimable; the drawn dots are an even spiral.
    this.landCells = new Set(cells.map(({ lat, lon }) => `${lat},${lon}`));

    this.dots = this.spiral(46000, (lat, lon) => this.landCells.has(`${lat},${lon}`));
    this.dotCells = new Set(this.dots.map((d) => `${d.lat},${d.lon}`));

    // Faint water lattice on the same even spacing, just coarser.
    this.oceanDots = this.spiral(6000, (lat, lon) => !this.landCells.has(`${lat},${lon}`));

    // Area-uniform sampling leaves the last degrees around each pole almost
    // empty, which reads as a bare circle. Fill each cap with an even disc of
    // dots (rows would stack into a visible ring).
    this.fillCap(1);
    this.fillCap(-1);
  }

  // Even disc of dots over a polar cap, snapped to cells. `sign` picks the pole.
  fillCap(sign) {
    const N = 100;
    const theta0 = 7 * Math.PI / 180;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N;
      const theta = Math.acos(1 - u * (1 - Math.cos(theta0)));
      const lat = Math.round(sign * (90 - theta * 180 / Math.PI));
      const lon = Math.floor((((i * golden * 180 / Math.PI) % 360) + 360) % 360 - 180);
      if (lat > 89 || lat < -90) continue;
      const key = `${lat},${lon}`;
      if (this.landCells.has(key) || this.dotCells.has(key)) continue;
      this.dotCells.add(key);
      this.dots.push({
        lat, lon,
        ...spherePoint(lat + 0.5, lon + 0.5),
        gain: 1,
        size: 1,
      });
    }
    // The exact pole points, drawn on the axis.
    const lat = sign > 0 ? 89.5 : -90.5;
    this.dots.push({
      lat, lon: 0, pole: true,
      ...spherePoint(sign * 90, 0),
      gain: 1,
      size: 1,
    });
  }

  // Random-shaped bumps that only exist where the glow is bright: two octaves
  // of multiplied waves give irregular patches of mixed sizes. Dark spots get
  // nothing, and as a patch fades its shapes shrink away with it.
  spikeFor(dot, t, v) {
    if (v < 0.35) return 0;
    const x = dot.x ?? 0, y = dot.y ?? 0, z = dot.z ?? 0;
    // World-fixed shape: a lit dot stays lit (only its height shakes). A slow
    // phase creeps the patch boundaries, so the active spikes keep reappearing
    // in fresh places rather than living on the same cells forever — no panning.
    const e =
      Math.sin(x * 9 + y * 7 + z * 5 + t * 0.4) *
        Math.sin(x * 7 - y * 11 + z * 6 - t * 0.25) +
      0.6 * Math.sin(x * 17 + y * 13 - z * 9 + t * 0.35) *
        Math.sin(x * 13 - y * 19 + z * 11 - t * 0.2);
    const m = Math.min(1, Math.max(0, (e - 0.45) / 0.75));
    const mask = m * m * (3 - 2 * m);
    if (mask <= 0) return 0;
    // Per-dot shake: two fast waves, out of phase, so each dot trembles on
    // its own rhythm instead of the whole shape moving.
    const ph = Math.abs(Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453) % 1;
    const shake = Math.sin(t * 31 + ph * 6.2832) * 0.6 + Math.sin(t * 47 - ph * 12.566) * 0.4;
    return mask * v * v * (0.6 + 0.4 * shake);
  }

  // Fibonacci spiral: equal spacing everywhere on the sphere, snapped to the
  // 1° claim cells so each dot sits where a claim lands. No square grid, and
  // nothing bunches up at the poles.
  spiral(count, accept) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    const seen = new Set();
    const out = [];
    for (let i = 0; i < count; i++) {
      const y = 1 - (2 * (i + 0.5)) / count;
      const phi = i * golden;
      const lat = Math.floor(Math.asin(y) * 180 / Math.PI);
      const lon = Math.floor((((phi * 180 / Math.PI) % 360) + 360) % 360 - 180);
      if (lat < -90 || lat > 89) continue;
      const key = `${lat},${lon}`;
      if (seen.has(key)) continue;
      if (!accept(lat, lon)) continue;
      seen.add(key);
      out.push({
        lat,
        lon,
        ...spherePoint(lat + 0.5, lon + 0.5),
        // Slight size variation keeps the lattice from looking printed.
        gain: 0.75 + Math.random() * 0.5,
        size: 0.9 + Math.random() * 0.45,
      });
    }
    return out;
  }

  buildRings(features) {
    const rings = [];
    for (const feature of features) {
      if (feature.geometry.type === 'Polygon') {
        for (const ring of feature.geometry.coordinates) {
          if (ring.length > 10) rings.push(ring);
        }
      } else if (feature.geometry.type === 'MultiPolygon') {
        for (const polygon of feature.geometry.coordinates) {
          for (const ring of polygon) {
            if (ring.length > 10) rings.push(ring);
          }
        }
      }
    }
    return rings;
  }

  project(lat, lon) {
    const latRad = lat * Math.PI / 180;
    const lonRad = lon * Math.PI / 180;
    const centerLat = this.centerLat;
    const centerLon = this.centerLon;

    let x = Math.cos(latRad) * Math.sin(lonRad);
    let y = Math.sin(latRad);
    let z = Math.cos(latRad) * Math.cos(lonRad);

    // Rotate so that (centerLat, centerLon) appears at center of view
    // 1. Rotate around Y by -centerLon
    const cosLon = Math.cos(-centerLon), sinLon = Math.sin(-centerLon);
    let nx = x * cosLon + z * sinLon;
    let nz = -x * sinLon + z * cosLon;
    x = nx; z = nz;

    // 2. Rotate around X by centerLat to bring centerLat to view center
    const pitch = centerLat;
    const cosPitch = Math.cos(pitch), sinPitch = Math.sin(pitch);
    const ny = y * cosPitch - z * sinPitch;
    nz = y * sinPitch + z * cosPitch;
    y = ny; z = nz;

    const { width, height } = this.getCanvasSize();
    const radius = Math.min(width, height) * 0.42 * this.scale;

    let visible = true;
    let sx, sy;

    if (this.projection === 'orthographic') {
      visible = z > 0.01;
      sx = this.centerX + x * radius;
      sy = this.centerY - y * radius;
    } else {
      const k = radius / (1.2 + z);
      sx = this.centerX + x * k;
      sy = this.centerY - y * k;
      visible = true;
    }

    return { x: sx, y: sy, z, visible, rawX: x, rawY: y, rawZ: z };
  }

  getCanvasSize() {
    return { width: this.width / this.dpr, height: this.height / this.dpr };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = rect.width;
    const cssH = rect.height;
    this.width = Math.round(cssW * this.dpr);
    this.height = Math.round(cssH * this.dpr);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.centerX = cssW / 2;
    this.centerY = cssH / 2;
  }

  bindEvents() {
    this.canvas.addEventListener('mousedown', e => this.onMouseDown(e));
    window.addEventListener('mousemove', e => this.onMouseMove(e));
    window.addEventListener('mouseup', () => this.onMouseUp());
    this.canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('click', e => this.onClick(e));

    this.canvas.addEventListener('touchstart', e => this.onTouchStart(e), { passive: false });
    this.canvas.addEventListener('touchmove', e => this.onTouchMove(e), { passive: false });
    this.canvas.addEventListener('touchend', e => this.onTouchEnd(e));

    document.getElementById('zoom-in')?.addEventListener('click', () => this.zoom(1.3));
    document.getElementById('zoom-out')?.addEventListener('click', () => this.zoom(1/1.3));
    document.getElementById('reset-view')?.addEventListener('click', () => this.resetView());
    document.getElementById('toggle-projection')?.addEventListener('click', () => this.toggleProjection());
    document.getElementById('locate-activity')?.addEventListener('click', () => this.locateRecentActivity());
    document.getElementById('panel-close')?.addEventListener('click', () => this.ui.closePanel());
  }

  onMouseDown(e) {
    if (e.button !== 0) return;
    this.isDragging = true;
    this.dragDistance = 0;
    this.lastMouse = { x: e.clientX, y: e.clientY };
    this.canvas.style.cursor = 'grabbing';
  }

  onMouseMove(e) {
    if (this.isDragging) {
      const dx = e.clientX - this.lastMouse.x;
      const dy = e.clientY - this.lastMouse.y;
      this.pan(dx, dy);
      this.lastMouse = { x: e.clientX, y: e.clientY };
    }
    this.updateHover(e.clientX, e.clientY);
  }

  // Drag the planet itself: the surface follows the pointer.
  // Drag right -> centre moves west; drag down -> centre moves north.
  pan(dx, dy) {
    this.dragDistance = (this.dragDistance || 0) + Math.abs(dx) + Math.abs(dy);
    const k = 0.006 / Math.max(0.5, this.scale);
    this.targetCenterLon -= dx * k;
    const lim = Math.PI / 2 - 0.05;
    this.targetCenterLat = Math.max(-lim, Math.min(lim, this.targetCenterLat + dy * k));
  }

  onMouseUp() {
    this.isDragging = false;
    this.canvas.style.cursor = this.hoveredCoord ? 'pointer' : 'grab';
  }

  onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1/1.1 : 1.1;
    this.zoom(factor);
  }

  onClick(e) {
    if (this.dragDistance > 6 || this.isDragging) return;
    const rect = this.canvas.getBoundingClientRect();
    this.selectAtPoint(e.clientX - rect.left, e.clientY - rect.top);
  }

  // Selecting anywhere on the planet marks it. A land cell also opens the
  // panel; open water just gets the ring so the pick is visible.
  selectAtPoint(px, py) {
    const ll = this.latLonAtPoint(px, py);
    if (!ll) {
      this.selectedMarker = null;
      return;
    }
    const cell = this.cellAtPoint(px, py);
    if (cell) {
      this.selectedMarker = { lat: cell.lat + 0.5, lon: cell.lon + 0.5 };
      this.selectCoord({ ...cell, x: px, y: py });
    } else {
      this.selectedMarker = { lat: ll.lat, lon: ll.lon };
      this.selectedCoord = null;
      this.ui.closePanel?.();
    }
  }

  // The lattice is the claim grid, so a pointer is inside exactly one cell.
  cellAtPoint(px, py) {
    const ll = this.latLonAtPoint(px, py);
    if (!ll) return null;
    const cell = { lat: Math.floor(ll.lat), lon: Math.floor(ll.lon) };
    if (cell.lat < -90 || cell.lat > 89) return null;
    if (cell.lon < -180 || cell.lon > 179) return null;
    return this.landCells?.has(`${cell.lat},${cell.lon}`) ? cell : null;
  }

  // Where on the planet a screen pixel lands, land or not. Null off the disc.
  latLonAtPoint(px, py) {
    const radius = this.baseRadius();
    if (radius <= 0) return null;

    let lat, lon;
    if (this.projection === 'orthographic') {
      const nx = (px - this.centerX) / radius;
      const ny = -(py - this.centerY) / radius;
      if (nx * nx + ny * ny > 1) return null;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const cosPitch = Math.cos(this.centerLat), sinPitch = Math.sin(this.centerLat);
      const yr = ny * cosPitch + nz * sinPitch;
      const zr = -ny * sinPitch + nz * cosPitch;
      const cosLon = Math.cos(this.centerLon), sinLon = Math.sin(this.centerLon);
      const xr = nx * cosLon + zr * sinLon;
      const zr2 = -nx * sinLon + zr * cosLon;
      lat = Math.asin(yr) * 180 / Math.PI;
      lon = Math.atan2(xr, zr2) * 180 / Math.PI;
    } else {
      const nx = (px - this.centerX) / radius;
      const ny = -(py - this.centerY) / radius;
      const r2 = nx * nx + ny * ny;
      if (r2 >= 1) return null;
      const z = Math.sqrt(1 - r2);
      const k = 1.2 + z;
      const wx = nx * k, wy = ny * k;
      const cosPitch = Math.cos(this.centerLat), sinPitch = Math.sin(this.centerLat);
      const yr = wy * cosPitch + z * sinPitch;
      const zr = -wy * sinPitch + z * cosPitch;
      const cosLon = Math.cos(this.centerLon), sinLon = Math.sin(this.centerLon);
      const xr = wx * cosLon + zr * sinLon;
      const zr2 = -wx * sinLon + zr * cosLon;
      lat = Math.asin(Math.max(-1, Math.min(1, yr))) * 180 / Math.PI;
      lon = Math.atan2(xr, zr2) * 180 / Math.PI;
    }
    return { lat, lon };
  }

  onTouchStart(e) {
    if (e.touches.length === 1) {
      this.isDragging = true;
      this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      this.isDragging = false;
      this.initialPinchDist = this.getPinchDist(e);
      this.initialScale = this.targetScale;
    }
    e.preventDefault();
  }

  onTouchMove(e) {
    if (e.touches.length === 1 && this.isDragging) {
      const dx = e.touches[0].clientX - this.lastMouse.x;
      const dy = e.touches[0].clientY - this.lastMouse.y;
      this.pan(dx, dy);
      this.lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else if (e.touches.length === 2) {
      const dist = this.getPinchDist(e);
      this.targetScale = this.initialScale * (dist / this.initialPinchDist);
      this.targetScale = Math.max(0.5, Math.min(4, this.targetScale));
    }
    e.preventDefault();
  }

  onTouchEnd(e) {
    if (e.changedTouches.length === 1 && !this.wasPinching) {
      const rect = this.canvas.getBoundingClientRect();
      const touch = e.changedTouches[0];
      this.selectAtPoint(touch.clientX - rect.left, touch.clientY - rect.top);
    }
    this.isDragging = false;
    this.wasPinching = false;
  }

  getPinchDist(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx*dx + dy*dy);
  }

  updateHover(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    this.hoveredCell = this.cellAtPoint(x, y);
    this.hoveredCoord = this.hoveredCell ? { ...this.hoveredCell, x, y } : null;
    this.canvas.style.cursor = this.hoveredCell ? 'pointer' : (this.isDragging ? 'grabbing' : 'grab');
  }

  selectCoord(coord) {
    this.selectedCoord = coord;
    this.ui.openPanel(coord);
  }

  zoom(factor) {
    this.targetScale = Math.max(0.5, Math.min(4, this.targetScale * factor));
  }

  resetView() {
    this.targetCenterLat = 0;
    this.targetCenterLon = 0;
    this.targetScale = 1;
  }

  toggleProjection() {
    this.projection = this.projection === 'orthographic' ? 'equirectangular' : 'orthographic';
  }

  locateRecentActivity() {
    if (this.recentActivity && this.recentActivity.length) {
      const act = this.recentActivity[0];
      this.selectedCoord = { lat: act.lat, lon: act.lon };
      this.ui.openPanel(this.selectedCoord);
    }
  }

  applyCellUpdate(cell) {
    const key = `${cell.lat},${cell.lon}`;
    this.cells.set(key, cell);

    // A claimed cell joins the dot lattice, so its colour sits in the grid
    // instead of floating in a sampling gap.
    if ((cell.contributor_count || 0) > 0 && this.dotCells && !this.dotCells.has(key)) {
      this.dotCells?.add(key);
      this.dots.push({
        lat: cell.lat,
        lon: cell.lon,
        ...spherePoint(cell.lat + 0.5, cell.lon + 0.5),
        gain: 1,
        size: 1.1,
      });
    }
  }

  updateStats(stats) {
    const contribEl = document.getElementById('status-contributions');
    const usersEl = document.getElementById('status-users');
    const cellsEl = document.getElementById('status-cells');
    if (contribEl) contribEl.textContent = stats.total_contributions?.toLocaleString() || '0';
    if (usersEl) usersEl.textContent = stats.unique_contributors?.toLocaleString() || '0';
    if (cellsEl) cellsEl.textContent = stats.active_cells?.toLocaleString() || '0';
  }

  startRenderLoop() {
    const loop = (t) => {
      try {
        if (t - this.lastFrame >= this.frameInterval) {
          this.lastFrame = t;
          this.tick(t);
          this.render();
        }
      } catch (err) {
        this.fatal(err);
        return;
      }
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  tick(t) {
    this.glowTime = t;
    this.centerLat += (this.targetCenterLat - this.centerLat) * 0.12;
    this.centerLon += (this.targetCenterLon - this.centerLon) * 0.12;
    this.scale += (this.targetScale - this.scale) * 0.12;
  }

  render() {
    const { width, height } = this.getCanvasSize();
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    if (this.projection === 'orthographic') {
      this.drawGlobeOutline(ctx);
    }

    this.drawDots(ctx);
    this.drawCells(ctx);
    this.drawSelectionMarker(ctx);
    this.drawCoordinateGrid(ctx);
  }

  baseRadius() {
    const { width, height } = this.getCanvasSize();
    return Math.min(width, height) * 0.42 * this.scale;
  }

  dotSize() {
    return Math.max(0.9, Math.min(1.9, this.baseRadius() / 380));
  }

  // Raise a projected point off the surface by a fraction of the radius.
  lifted(p, relief) {
    const lift = 1 + relief;
    return {
      x: this.centerX + (p.x - this.centerX) * lift,
      y: this.centerY + (p.y - this.centerY) * lift,
    };
  }

  // The uncompressed glow, 0..1, whatever mapping reduced motion uses.
  rawGlow(b) {
    return this.reduceMotion ? (b - 0.45) / 0.35 : b;
  }

  // How far this dot stands off the surface: smooth glow plus the fast spikes,
  // which only grow where the true glow is bright.
  reliefAt(dot, b, t) {
    const v = this.rawGlow(b);
    return Math.min(MAX_RELIEF, LIFT * b + SPIKE_LIFT * this.spikeFor(dot, t, v));
  }

  drawDots(ctx) {
    const size = this.dotSize();
    const t = this.glowTime / 1000;

    // Water lattice first, dim and static, so the sphere has a body.
    const ocean = [[], [], []];
    if (this.oceanDots) {
      for (const dot of this.oceanDots) {
        const p = this.project(dot.lat + 0.5, dot.lon + 0.5);
        if (p.z <= 0.03) continue;
        const ring = p.z > 0.62 ? 0 : p.z > 0.28 ? 1 : 2;
        ocean[ring].push(p.x, p.y);
      }
      const oceanAlpha = [0.13, 0.08, 0.04];
      const oceanSize = size * 0.8;
      for (let ring = 0; ring < 3; ring++) {
        ctx.fillStyle = `rgba(150,162,178,${oceanAlpha[ring]})`;
        const flat = ocean[ring];
        for (let i = 0; i < flat.length; i += 2) {
          ctx.fillRect(flat[i], flat[i + 1], oceanSize, oceanSize);
        }
      }
    }

    const land = [];
    for (let ring = 0; ring < 3; ring++) {
      land.push(Array.from({ length: GLOW_LEVELS }, () => []));
    }

    const stems = [];

    for (const dot of this.dots) {
      // Dots sit at the centre of their cell, exactly where a claim lands.
      const p = this.project(dot.lat + 0.5, dot.lon + 0.5);
      if (p.z <= 0.03) continue;
      const ring = p.z > 0.62 ? 0 : p.z > 0.28 ? 1 : 2;
      const b = dotBrightness(dot, t, this.reduceMotion);
      if (b <= 0.06) continue;
      const level = Math.min(GLOW_LEVELS - 1, Math.floor(b * GLOW_LEVELS));
      const v = this.rawGlow(b);
      const s = this.spikeFor(dot, t, v);
      const q = this.lifted(p, Math.min(MAX_RELIEF, LIFT * b + SPIKE_LIFT * s));
      land[ring][level].push(
        q.x,
        q.y,
        dot.size * dot.gain * (0.45 + 0.75 * b) * (1 + 2 * s)
      );
      // Hill centres get a faint stem so the lift reads as height.
      if (s > 0.35) stems.push(p.x, p.y, q.x, q.y, 0.06 + 0.16 * b);
    }

    // Stems first, so the bright head of each bump sits on top of its line.
    for (let i = 0; i < stems.length; i += 5) {
      ctx.strokeStyle = `rgba(150,160,175,${stems[i + 4].toFixed(2)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(stems[i], stems[i + 1]);
      ctx.lineTo(stems[i + 2], stems[i + 3]);
      ctx.stroke();
    }

    const base = [0.95, 0.66, 0.36];
    for (let ring = 0; ring < 3; ring++) {
      for (let level = 0; level < GLOW_LEVELS; level++) {
        const alpha = Math.min(1, base[ring] * (0.10 + 0.95 * ((level + 0.5) / GLOW_LEVELS)));
        ctx.fillStyle = `rgba(232,237,244,${alpha.toFixed(3)})`;
        const flat = land[ring][level];
        for (let i = 0; i < flat.length; i += 3) {
          const s = size * flat[i + 2];
          ctx.fillRect(flat[i], flat[i + 1], s, s);
        }
      }
    }
  }

  drawGlobeOutline(ctx) {
    const { width, height } = this.getCanvasSize();
    const radius = Math.min(width, height) * 0.42 * this.scale;
    ctx.save();

    // Outer limb
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.centerX, this.centerY, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Graticule follows the projection so it pans with the planet
    ctx.strokeStyle = 'rgba(255,255,255,0.032)';
    ctx.lineWidth = 0.75;

    const stroke = (pts) => {
      if (pts.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    };

    for (let lat = -60; lat <= 60; lat += 30) {
      const pts = [];
      for (let lon = -180; lon <= 180; lon += 4) {
        const p = this.project(lat, lon);
        if (p.visible) pts.push(p);
        else { stroke(pts); pts.length = 0; }
      }
      stroke(pts);
    }

    for (let lon = -180; lon < 180; lon += 30) {
      const pts = [];
      for (let lat = -90; lat <= 90; lat += 4) {
        const p = this.project(lat, lon);
        if (p.visible) pts.push(p);
        else { stroke(pts); pts.length = 0; }
      }
      stroke(pts);
    }

    ctx.restore();
  }

  drawCoordinateGrid(ctx) {
    if (this.projection !== 'equirectangular') return;
    const { width, height } = this.getCanvasSize();
    const radius = Math.min(width, height) * 0.42 * this.scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let lat = -90; lat <= 90; lat += 30) {
      const y = this.centerY + Math.sin(lat * Math.PI / 180) * radius;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    for (let lon = -180; lon <= 180; lon += 30) {
      const x = this.centerX + Math.sin(lon * Math.PI / 180) * radius;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCells(ctx) {
    const t = this.glowTime / 1000;
    for (const [key, cell] of this.cells) {
      if (cell.contributor_count === 0) continue;
      const p = this.project(cell.lat + 0.5, cell.lon + 0.5);
      if (!p.visible) continue;

      const pos = spherePoint(cell.lat + 0.5, cell.lon + 0.5);
      const b = dotBrightness(pos, t, this.reduceMotion);
      const q = this.lifted(p, this.reliefAt(pos, b, t));
      const cellSize = Math.max(3, this.baseRadius() / 150);

      const rgb = this.hexToRgb(cell.color);
      if (!rgb) continue;

      ctx.fillStyle = `rgba(${rgb.r},${rgb.g},${rgb.b},0.92)`;
      ctx.beginPath();
      ctx.arc(q.x, q.y, cellSize, 0, Math.PI * 2);
      ctx.fill();

      const isHovered = this.hoveredCell && this.hoveredCell.lat === cell.lat && this.hoveredCell.lon === cell.lon;
      if (isHovered) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(q.x, q.y, cellSize + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // The pick ring: drawn for any selected spot, claimed land or open water.
  drawSelectionMarker(ctx) {
    if (!this.selectedMarker) return;
    const p = this.project(this.selectedMarker.lat, this.selectedMarker.lon);
    if (!p.visible) return;
    const pos = spherePoint(this.selectedMarker.lat, this.selectedMarker.lon);
    const t = this.glowTime / 1000;
    const b = dotBrightness(pos, t, this.reduceMotion);
    const q = this.lifted(p, this.reliefAt(pos, b, t));
    const cellSize = Math.max(3, this.baseRadius() / 150);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(q.x, q.y, cellSize + 4, 0, Math.PI * 2);
    ctx.stroke();
  }

  hexToRgb(hex) {
    const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    return m ? { r: parseInt(m[1],16), g: parseInt(m[2],16), b: parseInt(m[3],16) } : null;
  }

  destroy() {
    cancelAnimationFrame(this.animationId);
  }
}