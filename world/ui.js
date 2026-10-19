import { db, uid, username, userColor } from './db.js';

// A publish claims the dot only when the dot is unclaimed, this browser owns no
// dot yet, and it has not already posted on this one. Otherwise it is a message.
export function shouldClaim(dotHasOwner, iOwnADot, alreadyPosted) {
  return !dotHasOwner && !iOwnADot && !alreadyPosted;
}

export class UI {
  constructor() {
    this.globe = null;
    this.currentView = 'globe';
    this.selectedCell = null;
    this.user = null;
    this.myClaim = null;
    this.claimsSupported = true;
  }

  async init(globe) {
    this.globe = globe;
    this.bindEvents();
    await this.loadIdentity();
    await this.loadInitialData();
  }

  bindEvents() {
    document.querySelectorAll('[data-view]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        this.switchView(e.currentTarget.dataset.view);
      });
    });

    document.getElementById('panel-close').addEventListener('click', () => this.closePanel());
  }

  // Anonymous identity: a local id, no sign-in. It is sent as x-client-id so
  // row level security only lets this browser edit its own contribution.
  async loadIdentity() {
    this.user = { id: uid(), username: username(), color: userColor() };
  }

  // ---- data -------------------------------------------------------------

  async loadInitialData() {
    await Promise.all([this.refreshState(), this.loadMyClaim()]);
  }

  // The one dot this browser has claimed, or null. Cached so opening a dot or
  // publishing never needs an extra round trip. If the database predates the
  // is_claim column, claims are simply not enforced.
  async loadMyClaim() {
    try {
      const rows = await db.select(
        `contributions?user_id=eq.${this.user.id}&is_claim=eq.true&select=lat,lon&limit=1`
      );
      this.myClaim = rows && rows[0] ? { lat: rows[0].lat, lon: rows[0].lon } : null;
    } catch (e) {
      this.claimsSupported = false;
      console.error('Failed to load claim', e);
    }
  }

  async refreshState() {
    try {
      const [cells, activity, stats] = await Promise.all([
        db.select('cell_summary?select=*'),
        db.select('contributions?select=username,message,color,lat,lon,created_at&order=created_at.desc&limit=20'),
        db.select('stats?select=*'),
      ]);
      for (const cell of cells || []) this.globe.applyCellUpdate(cell);
      this.globe.recentActivity = activity || [];
      this.globe.updateStats((stats && stats[0]) || {});
      if (this.currentView === 'activity') this.renderActivity();
    } catch (e) {
      console.error('Failed to refresh state', e);
    }
  }

  // Static hosting with a metered request quota: no live polling. State is
  // fetched on load, when a cell is opened, and after a contribution is sent.

  switchView(view) {
    this.currentView = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${view}`)?.classList.add('active');
    document.querySelectorAll('[data-view]').forEach(a => a.style.color = a.dataset.view === view ? '#fff' : 'rgba(255,255,255,0.7)');
    document.getElementById('globe').style.display = view === 'globe' ? 'block' : 'none';

    if (view === 'activity') this.renderActivity();
    else if (view === 'stats') this.renderStats();
  }

  async openPanel(coord) {
    this.selectedCell = coord;
    const panel = document.getElementById('panel');
    const title = document.getElementById('panel-title');

    title.textContent = `CELL ${Math.abs(coord.lat)}°${coord.lat >= 0 ? 'N' : 'S'} ${Math.abs(coord.lon)}°${coord.lon >= 0 ? 'E' : 'W'}`;
    panel.classList.add('open');

    this.renderPanel(coord, this.globe.cells.get(`${coord.lat},${coord.lon}`), []);
    await this.refreshPanel();
  }

  async refreshPanel() {
    if (!this.selectedCell) return;
    const target = { lat: this.selectedCell.lat, lon: this.selectedCell.lon };
    try {
      const rows = await db.select(
        `contributions?lat=eq.${target.lat}&lon=eq.${target.lon}&select=*&order=created_at.desc&limit=50`
      );
      // Ignore a slow response for a dot the user has already moved away from.
      if (!this.selectedCell ||
          this.selectedCell.lat !== target.lat ||
          this.selectedCell.lon !== target.lon) return;

      const owner = (rows || []).find((r) => r.is_claim) || (rows && rows[0]);
      const cell = (rows && rows.length)
        ? {
            lat: target.lat,
            lon: target.lon,
            contributor_count: new Set(rows.map((r) => r.user_id)).size,
            contribution_count: rows.length,
            last_activity: rows[0].created_at,
            color: owner.color,
          }
        : this.globe.cells.get(`${target.lat},${target.lon}`) || null;

      this.renderPanel(target, cell, rows || []);
    } catch (e) {
      console.error('Failed to load cell', e);
    }
  }

  renderPanel(coord, cell, contributions) {
    const content = document.getElementById('panel-content');
    if (!content) return;
    content.innerHTML = this.renderPanelContent(coord, cell, contributions);
    this.bindPanelEvents(coord, cell, contributions);
  }

  renderPanelContent(coord, cell, contributions = []) {
    const color = cell?.color || '#666666';
    const contribCount = cell?.contribution_count || 0;
    const uniqueCount = cell?.contributor_count || 0;
    const lastActivity = cell?.last_activity ? new Date(cell.last_activity).toISOString().replace('T', ' ').slice(0, 19) : 'Never';
    const mine = this.user ? contributions.find(c => c.user_id === this.user.id) : null;

    let html = `
      <div class="cell-meta">
        <span class="label">Coordinates</span><span class="value">${coord.lat.toFixed(4)}°, ${coord.lon.toFixed(4)}°</span>
        <span class="label">Cell ID</span><span class="value">${coord.lat},${coord.lon}</span>
        <span class="label">Current Color</span><span class="value"><span class="color-swatch" style="background:${color}"></span> ${color}</span>
        <span class="label">Unique Contributors</span><span class="value">${uniqueCount}</span>
        <span class="label">Total Contributions</span><span class="value">${contribCount}</span>
        <span class="label">Last Activity</span><span class="value">${lastActivity}</span>
      </div>
      <div class="divider"></div>
      <div>
        <div class="section-label">Messages</div>
        <div class="messages">${this.renderMessages(contributions)}</div>
      </div>
    `;

    const owner = contributions.find((c) => c.is_claim);
    if (mine) {
      html += `
        <div class="panel-note">
          <span>${mine.is_claim ? 'You own this dot.' : 'You left a message here.'}</span>
          <button type="button" class="inline-btn" id="remove-contrib">Remove</button>
        </div>`;
    } else if (owner) {
      html += `<div class="panel-note"><span>Owner: ${this.escapeHtml(owner.username)} — you can still leave one message.</span></div>`;
    } else if (this.myClaim) {
      html += `<div class="panel-note"><span>You already claimed another dot — this will be a message, not a claim.</span></div>`;
    }

    html += this.renderContributionForm(coord, cell, mine);

    return html;
  }

  renderMessages(contributions) {
    if (!contributions.length) return '<div class="panel-empty">No contributions yet</div>';
    return contributions.slice(0, 10).map(c => `
      <div class="msg">
        <div class="msg-header"><span class="msg-author">${this.escapeHtml(c.username)}${c.is_claim ? ' · OWNER' : ''}</span><span class="msg-time">${new Date(c.created_at).toLocaleString()}</span></div>
        <div class="msg-text">${this.escapeHtml(c.message)}</div>
      </div>
    `).join('');
  }

  renderContributionForm(coord, cell, mine = null) {
    const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#b983ff', '#ff8fab', '#00d4d4', '#ffa500', '#ffffff'];
    const chosen = mine?.color || colors[0];
    const message = mine?.message ? this.escapeHtml(mine.message) : '';
    const label = mine ? 'Update message' : 'Publish';
    return `
      <form class="contribute-form" id="contribute-form">
        <div class="form-row">
          <label class="form-label" for="contrib-message">${mine ? 'Your message' : 'Message'}</label>
          <textarea class="form-input" id="contrib-message" name="message" rows="3" maxlength="280" placeholder="Leave your mark..." required>${message}</textarea>
          <span class="char-count"><span id="char-count">${mine?.message?.length || 0}</span>/280</span>
        </div>
        <div class="form-row">
          <label class="form-label">Color</label>
          <div class="color-picker" id="color-picker">
            ${colors.map(c => `<button type="button" class="color-option${c === chosen ? ' selected' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
          </div>
        </div>
        <button type="submit" class="submit-btn" id="submit-contrib">${label}</button>
        ${mine ? `<div class="form-hint">One message per dot — editing replaces it.</div>` : ''}
      </form>
    `;
  }

  bindPanelEvents(coord, cell, contributions = []) {
    const mine = this.user ? contributions.find(c => c.user_id === this.user.id) : null;
    const editing = Boolean(mine);
    const owner = contributions.find(c => c.is_claim);
    const claimThisDot = shouldClaim(Boolean(owner), Boolean(this.myClaim), editing);
    const msgInput = document.getElementById('contrib-message');
    const charCount = document.getElementById('char-count');
    const colorOptions = document.querySelectorAll('#color-picker .color-option');
    const form = document.getElementById('contribute-form');
    let selectedColor = document.querySelector('#color-picker .color-option.selected')?.dataset.color
      || colorOptions[0]?.dataset.color;

    msgInput?.addEventListener('input', () => {
      if (charCount) charCount.textContent = msgInput.value.length;
    });

    colorOptions.forEach(opt => {
      opt.addEventListener('click', () => {
        colorOptions.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        selectedColor = opt.dataset.color;
      });
    });

    document.getElementById('remove-contrib')?.addEventListener('click', async () => {
      const btn = document.getElementById('remove-contrib');
      btn.disabled = true;
      btn.textContent = 'Removing...';
      try {
        await db.remove(
          `contributions?lat=eq.${coord.lat}&lon=eq.${coord.lon}&user_id=eq.${this.user.id}`
        );
        if (mine.is_claim) this.myClaim = null;
        // Drop the local colour; refreshState restores it if others still chat here.
        this.globe.cells.delete(`${coord.lat},${coord.lon}`);
        this.toast(mine.is_claim ? 'Claim removed — you can claim another dot' : 'Message removed');
        await this.refreshPanel();
        this.refreshState();
      } catch (err) {
        this.toast(err.status ? `Request failed (${err.status})` : 'Network error — nothing removed', true);
        btn.disabled = false;
        btn.textContent = 'Remove';
      }
    });

    form?.addEventListener('submit', async e => {
      e.preventDefault();
      const message = msgInput.value.trim();
      if (!message) return;

      const btn = document.getElementById('submit-contrib');
      btn.disabled = true;
      btn.textContent = editing ? 'Updating...' : 'Publishing...';

      try {
        if (editing) {
          await db.patch(
            `contributions?lat=eq.${coord.lat}&lon=eq.${coord.lon}&user_id=eq.${this.user.id}`,
            { message, color: selectedColor }
          );
        } else {
          const row = {
            lat: coord.lat,
            lon: coord.lon,
            user_id: this.user.id,
            username: this.user.username,
            message,
            color: selectedColor,
          };
          if (this.claimsSupported) row.is_claim = claimThisDot;
          await db.insert('contributions', row);
          if (this.claimsSupported && claimThisDot) this.myClaim = { lat: coord.lat, lon: coord.lon };
        }

        this.toast(editing ? 'Message updated' : (this.claimsSupported && claimThisDot ? 'Dot claimed' : 'Message published'));
        await this.refreshPanel();
        this.refreshState();
        if (this.currentView === 'activity') this.renderActivity();
      } catch (err) {
        if (err.status === 409) {
          this.toast('Already saved — refreshing', true);
          await this.loadMyClaim();
          this.refreshPanel();
        } else {
          this.toast(err.status ? `Request failed (${err.status})` : 'Network error — not saved', true);
        }
      } finally {
        const live = document.getElementById('submit-contrib');
        if (live) {
          live.disabled = false;
          live.textContent = editing ? 'Update message' : 'Publish';
        }
      }
    });
  }

  updatePanel(cell, contributions) {
    if (!this.selectedCell) return;
    this.renderPanel(this.selectedCell, cell, contributions || []);
  }

  closePanel() {
    document.getElementById('panel').classList.remove('open');
    this.selectedCell = null;
  }

  renderActivity() {
    const list = document.getElementById('activity-list');
    const activities = this.globe.recentActivity || [];
    list.innerHTML = activities.map(a => `
      <div class="activity-item" data-lat="${a.lat}" data-lon="${a.lon}">
        <div class="activity-color" style="background:${a.color}"></div>
        <div class="activity-info">
          <div class="activity-author">${a.username}</div>
          <div class="activity-preview">${this.escapeHtml(a.message)}</div>
        </div>
        <div class="activity-meta">${a.lat.toFixed(2)}°, ${a.lon.toFixed(2)}° • ${new Date(a.created_at).toLocaleString()}</div>
      </div>
    `).join('') || '<div style="color:rgba(255,255,255,0.4);text-align:center;padding:40px">No activity yet</div>';

    list.querySelectorAll('.activity-item').forEach(item => {
      item.addEventListener('click', () => {
        const lat = parseFloat(item.dataset.lat);
        const lon = parseFloat(item.dataset.lon);
        this.globe.selectedCoord = { lat, lon };
        this.globe.ui.openPanel(this.globe.selectedCoord);
        this.switchView('globe');
      });
    });
  }

  async renderStats() {
    try {
      const [statsRows, leaders, cells] = await Promise.all([
        db.select('stats?select=*'),
        db.select('leaderboard?select=*'),
        db.select('cell_summary?select=*'),
      ]);
      const stats = (statsRows && statsRows[0]) || {};

      document.getElementById('stats-grid').innerHTML = `
        <div class="stat-card"><div class="stat-value">${(stats.total_contributions||0).toLocaleString()}</div><div class="stat-label">Total Contributions</div></div>
        <div class="stat-card"><div class="stat-value">${(stats.unique_contributors||0).toLocaleString()}</div><div class="stat-label">Unique Contributors</div></div>
        <div class="stat-card"><div class="stat-value">${(stats.active_cells||0).toLocaleString()}</div><div class="stat-label">Active Cells</div></div>
      `;

      document.getElementById('leaderboard').innerHTML = (leaders || []).map((l, i) => `
        <div class="leader-item">
          <span class="leader-rank">${i+1}</span>
          <span class="leader-color" style="background:${l.color}"></span>
          <span class="leader-name">${l.username}</span>
          <span class="leader-count">${l.count}</span>
        </div>
      `).join('') || '<div style="color:rgba(255,255,255,0.4);text-align:center;padding:20px">No contributors yet</div>';

      this.drawHistoryChart(cells || []);
    } catch (e) {
      console.error('Failed to load stats', e);
    }
  }

  drawHistoryChart(cells) {
    const canvas = document.getElementById('history-chart');
    const ctx = canvas.getContext('2d');
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height;

    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, w, h);

    const now = Date.now();
    const dayMs = 86400000;
    const days = 30;
    const buckets = new Array(days).fill(0);

    for (const cell of cells) {
      const when = cell.last_activity ? new Date(cell.last_activity).getTime() : 0;
      if (when) {
        const idx = Math.floor((now - when) / dayMs);
        if (idx >= 0 && idx < days) buckets[days - 1 - idx] += cell.contribution_count || 0;
      }
    }

    const maxVal = Math.max(...buckets, 1);
    const barW = w / days * 0.7;
    const gap = w / days * 0.3;

    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    for (let i = 0; i < days; i++) {
      const bh = (buckets[i] / maxVal) * (h - 20);
      const x = i * (barW + gap) + gap/2;
      ctx.fillRect(x, h - bh - 10, barW, bh);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = 10 + (h - 20) * i / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  addActivity(activity) {
    if (this.currentView === 'activity') this.renderActivity();
  }

  escapeHtml(str) {
    // Numeric entities so this file never needs literal ampersand entities.
    return String(str).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
  }

  toast(message, isError = false) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast' + (isError ? ' error' : '');
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }
}