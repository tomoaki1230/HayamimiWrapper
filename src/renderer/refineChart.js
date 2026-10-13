/*
 * 清書の遅れグラフ。
 * - RefineLagTracker: 速報（final）と清書（refine）の到着時刻から、遅れとたまり具合を計算する（DOM 非依存・テスト対象）
 *     遅れ = 清書が届いた時刻 − その清書がまとめた速報のうち最も早く届いたものの時刻
 *     たまり具合 = 清書待ちの速報の件数と、最も古い清書待ちの待ち時間
 * - RefineLagChart  : 数値の 1 行表示と、直近 5 分の 2 段グラフ（時間軸共通）
 *     上段（秒）: 線 = 最も古い清書待ちの待ち時間（待つ間は増え、清書が届くと下がり、清書待ちがなければ 0）
 *                 点 = 清書が届いたときの遅れ
 *     下段（件）: 清書待ちの件数
 *
 * 単位の違う 2 つの値は 1 つのグラフに重ねず（2 軸にしない）、時間軸をそろえた 2 段に分ける。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WINDOW_MS = 5 * 60 * 1000; // グラフに表示する範囲（直近 5 分）
  const WARN_OLDEST_S = 30; // 最も古い清書待ちがこれ以上待っていたら「追いついていない」
  const WARN_PENDING = 10; // 清書待ちがこれ以上たまっていたら「追いついていない」

  class RefineLagTracker {
    constructor(opts = {}) {
      this.windowMs = opts.windowMs || WINDOW_MS;
      this.reset();
    }

    reset() {
      this.arrive = new Map(); // seg_id → 速報の到着時刻（ms）
      this.points = []; // { t, delay(秒), count(まとめた速報数) }
      this.pendingSeries = []; // { t, v(清書待ち件数), oldest(最も古い清書待ちの到着時刻 ms / null) } 変化した時点のみ
    }

    get pending() {
      return this.arrive.size;
    }

    pushPending(now) {
      const oldest = this.arrive.size ? Math.min(...this.arrive.values()) : null;
      this.pendingSeries.push({ t: now, v: this.arrive.size, oldest });
    }

    /** pendingSeries（時刻順）のうち、時刻 t 以前で最後の点の位置（なければ -1）。二分探索 */
    seriesIndexAt(t) {
      const a = this.pendingSeries;
      let lo = 0; let hi = a.length - 1; let ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }

    /** 指定時刻の「最も古い清書待ちの待ち時間」（秒）。清書待ちがなければ 0 */
    waitAt(t) {
      const i = this.seriesIndexAt(t);
      const oldest = i < 0 ? null : this.pendingSeries[i].oldest;
      return oldest == null ? 0 : Math.max(0, (t - oldest) / 1000);
    }

    /** 速報が届いた */
    onFinal(segId, now = Date.now()) {
      if (segId == null || this.arrive.has(segId)) return;
      this.arrive.set(segId, now);
      this.pushPending(now);
      this.trim(now);
    }

    /** 清書が届いた。遅れの点を返す（対応する速報がなければ null） */
    onRefine(covers, now = Date.now()) {
      const ids = (Array.isArray(covers) ? covers : []).filter((id) => this.arrive.has(id));
      if (!ids.length) return null;
      const earliest = Math.min(...ids.map((id) => this.arrive.get(id)));
      for (const id of ids) this.arrive.delete(id);
      this.pushPending(now);
      const point = { t: now, delay: Math.max(0, (now - earliest) / 1000), count: ids.length };
      this.points.push(point);
      this.trim(now);
      return point;
    }

    /** 清書が出ずに終わった速報（清書待ちから外すだけで、遅れの点は付けない） */
    onSkip(covers, now = Date.now()) {
      let removed = 0;
      for (const id of Array.isArray(covers) ? covers : []) if (this.arrive.delete(id)) removed++;
      if (removed) this.pushPending(now);
      return removed;
    }

    /** 最も古い清書待ちの待ち時間（秒）。なければ 0 */
    oldestWait(now = Date.now()) {
      if (!this.arrive.size) return 0;
      return Math.max(0, (now - Math.min(...this.arrive.values())) / 1000);
    }

    /** 指定時刻の清書待ち件数（ステップ） */
    pendingAt(t) {
      const i = this.seriesIndexAt(t);
      return i < 0 ? 0 : this.pendingSeries[i].v;
    }

    stats(now = Date.now()) {
      const recent = this.points.filter((p) => p.t >= now - this.windowMs);
      const latest = this.points.length ? this.points[this.points.length - 1] : null;
      const avg = recent.length ? recent.reduce((s, p) => s + p.delay, 0) / recent.length : null;
      const max = recent.length ? Math.max(...recent.map((p) => p.delay)) : null;
      const oldest = this.oldestWait(now);
      const behind = oldest >= WARN_OLDEST_S || this.pending >= WARN_PENDING;
      return { pending: this.pending, oldest, latest: latest ? latest.delay : null, avg, max, behind, count: recent.length };
    }

    /** 古いデータを捨てる（表示範囲の 2 倍より前） */
    trim(now) {
      const cut = now - this.windowMs * 2;
      while (this.points.length && this.points[0].t < cut) this.points.shift();
      // 範囲開始時点の件数が分かるよう、範囲外でも直前の 1 点は残す
      while (this.pendingSeries.length > 1 && this.pendingSeries[1].t < cut) this.pendingSeries.shift();
    }
  }

  /* ---------- 表示 ---------- */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const pad2 = (n) => String(n).padStart(2, '0');
  const clock = (ms, sec = true) => {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}${sec ? `:${pad2(d.getSeconds())}` : ''}`;
  };
  const fmtSec = (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(1) : Math.round(v)} 秒`);

  function el(tag, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }

  /** 0 から始まる「きりのよい」最大値 */
  function niceMax(v, min) {
    const x = Math.max(v, min);
    const steps = [1, 2, 2.5, 5, 10];
    const mag = 10 ** Math.floor(Math.log10(x));
    for (const s of steps) if (s * mag >= x) return s * mag;
    return 10 * mag;
  }

  class RefineLagChart {
    /** @param {HTMLElement} host */
    constructor(host) {
      this.tracker = new RefineLagTracker();
      this.host = host;
      this.expanded = false;
      host.innerHTML = `
        <div class="card lag-card">
          <button class="lag-head" type="button" aria-expanded="false">
            <span class="lag-title">清書の遅れ</span>
            <span class="lag-status"></span>
            <span class="lag-stats">
              <span class="lag-stat"><b data-k="pending">0</b><small>清書待ち（件）</small></span>
              <span class="lag-stat"><b data-k="oldest">—</b><small>最も古い清書待ち</small></span>
              <span class="lag-stat"><b data-k="latest">—</b><small>直近の遅れ</small></span>
              <span class="lag-stat"><b data-k="avg">—</b><small>平均の遅れ（5 分）</small></span>
            </span>
            <span class="lag-toggle">グラフ ▾</span>
          </button>
          <div class="lag-body" hidden>
            <div class="lag-plot"><svg class="lag-svg" role="img" aria-label="清書の遅れ（秒）と清書待ちの件数の推移（直近 5 分）"></svg><div class="lag-tip" hidden></div></div>
            <p class="lag-note">清書は発言の区切り（約 2 秒の無音）を待ってから始まるため、数秒〜十数秒の遅れは正常です。
              上のグラフが右上がりに伸び続けたり、清書待ちが増え続けたりする場合は、処理が追いついていません（スレッド数を増やす、「話者を区別」を OFF にする等で軽くなります）。</p>
            <details class="lag-table-wrap"><summary>数値を表で見る</summary>
              <table class="lag-table"><thead><tr><th>清書の時刻</th><th>遅れ</th><th>まとめた速報</th></tr></thead><tbody></tbody></table>
            </details>
          </div>
        </div>`;
      this.svg = host.querySelector('.lag-svg');
      this.tip = host.querySelector('.lag-tip');
      this.head = host.querySelector('.lag-head');
      this.body = host.querySelector('.lag-body');
      this.head.addEventListener('click', () => this.setExpanded(!this.expanded));
      this.svg.addEventListener('pointermove', (e) => this.hover(e));
      this.svg.addEventListener('pointerleave', () => this.hover(null));
      this.timer = setInterval(() => this.render(), 1000);
      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => { if (this.expanded) this.draw(); }).observe(this.svg);
      }
      this.render();
    }

    setExpanded(on) {
      this.expanded = !!on;
      this.body.hidden = !this.expanded;
      this.head.setAttribute('aria-expanded', String(this.expanded));
      this.host.querySelector('.lag-toggle').textContent = this.expanded ? 'グラフ ▴' : 'グラフ ▾';
      if (this.onToggle) this.onToggle(this.expanded);
      this.render();
    }

    reset() {
      this.tracker.reset();
      this.render();
    }

    onFinal(segId) {
      this.tracker.onFinal(segId);
      this.render();
    }

    onSkip(covers) {
      if (this.tracker.onSkip(covers)) this.render();
    }

    onRefine(covers) {
      if (this.tracker.onRefine(covers)) {
        this.render();
        this.renderTable();
      }
    }

    render() {
      const s = this.tracker.stats();
      const set = (k, v) => { this.host.querySelector(`[data-k="${k}"]`).textContent = v; };
      set('pending', String(s.pending));
      set('oldest', s.pending ? fmtSec(s.oldest) : '—');
      set('latest', fmtSec(s.latest));
      set('avg', fmtSec(s.avg));
      const status = this.host.querySelector('.lag-status');
      const hasData = s.pending || s.count;
      status.className = `lag-status ${!hasData ? '' : s.behind ? 'warn' : 'ok'}`;
      status.textContent = !hasData ? '' : s.behind ? '⚠ 清書が追いついていません' : '✓ 順調';
      if (this.expanded) this.scheduleDraw();
    }

    /** グラフの描き直しは、イベントごとではなく 1 コマ 1 回・最大 0.25 秒に 1 回にまとめる */
    scheduleDraw() {
      if (this.drawTimer) return;
      const wait = Math.max(0, 250 - (Date.now() - (this.lastDraw || 0)));
      this.drawTimer = setTimeout(() => {
        const run = () => {
          this.drawTimer = null;
          this.lastDraw = Date.now();
          if (this.expanded) this.draw();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else run();
      }, wait);
    }

    renderTable() {
      const tbody = this.host.querySelector('.lag-table tbody');
      tbody.textContent = '';
      for (const p of this.tracker.points.slice(-30).reverse()) {
        const tr = document.createElement('tr');
        for (const v of [clock(p.t), fmtSec(p.delay), `${p.count} 件`]) {
          const td = document.createElement('td');
          td.textContent = v;
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }

    /** 2 段グラフを描く（上: 遅れ / 下: 清書待ち） */
    draw() {
      const svg = this.svg;
      const W = Math.max(320, svg.clientWidth || 600);
      const H = 196;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('height', H);
      svg.textContent = '';
      const now = Date.now();
      // 表示範囲: 直近 5 分。始めたばかりでデータが少ないうちは、最初のデータに合わせて狭める（最短 1 分）
      const first = Math.min(
        this.tracker.points.length ? this.tracker.points[0].t : Infinity,
        this.tracker.pendingSeries.length ? this.tracker.pendingSeries[0].t : Infinity,
      );
      const span = Number.isFinite(first) ? Math.min(this.tracker.windowMs, Math.max(60000, (now - first) * 1.1)) : this.tracker.windowMs;
      const t0 = now - span;
      const L = 46; const R = 14;
      const top = { y: 22, h: 84 }; // 遅れ
      const bot = { y: 136, h: 36 }; // 清書待ち
      const x = (t) => L + ((t - t0) / (now - t0)) * (W - L - R);
      this.geom = { L, R, W, t0, now, top, bot, x };

      const pts = this.tracker.points.filter((p) => p.t >= t0);
      const series = this.tracker.pendingSeries;
      // 待ち時間の線の頂点（各変化点の直前と現在）も縦軸の最大に含める
      const waitPeaks = [this.tracker.waitAt(now)];
      for (const p of series) if (p.t >= t0) waitPeaks.push(this.tracker.waitAt(p.t - 1));
      const yMax = niceMax(Math.max(0, ...pts.map((p) => p.delay), ...waitPeaks) * 1.15, 10);
      const yTop = (v) => top.y + top.h - (v / yMax) * top.h;
      const visibleMax = Math.max(0, this.tracker.pendingAt(t0), ...series.filter((p) => p.t >= t0).map((p) => p.v));
      const pMax = niceMax(visibleMax, 4);
      const yBot = (v) => bot.y + bot.h - (v / pMax) * bot.h;
      this.geom.yTop = yTop; this.geom.yBot = yBot;

      // 見出し（各段が何を示すか。単系列なので凡例は置かない）
      el('text', { x: L, y: 12, class: 'lag-axis-title' }, svg).textContent = '清書の遅れ（秒）';
      // 上段は線と点の 2 種類なので、見本を添える
      const lg = el('g', { class: 'lag-legend' }, svg);
      const lx = L + 120;
      el('line', { x1: lx, x2: lx + 16, y1: 8, y2: 8, class: 'lag-line' }, lg);
      el('text', { x: lx + 22, y: 12, class: 'lag-tick' }, lg).textContent = '最も古い清書待ちの待ち時間';
      const lx2 = lx + 210;
      el('circle', { cx: lx2 + 6, cy: 8, r: 4, class: 'lag-dot' }, lg);
      el('text', { x: lx2 + 16, y: 12, class: 'lag-tick' }, lg).textContent = '清書が届いたときの遅れ';
      el('text', { x: L, y: bot.y - 8, class: 'lag-axis-title' }, svg).textContent = '清書待ち（件）';

      // 補助線と目盛り（控えめに）
      for (const v of [0, yMax / 2, yMax]) {
        el('line', { x1: L, x2: W - R, y1: yTop(v), y2: yTop(v), class: v === 0 ? 'lag-base' : 'lag-grid' }, svg);
        el('text', { x: L - 6, y: yTop(v) + 4, class: 'lag-tick', 'text-anchor': 'end' }, svg).textContent = String(+v.toFixed(1));
      }
      for (const v of [0, pMax]) {
        el('line', { x1: L, x2: W - R, y1: yBot(v), y2: yBot(v), class: v === 0 ? 'lag-base' : 'lag-grid' }, svg);
        el('text', { x: L - 6, y: yBot(v) + 4, class: 'lag-tick', 'text-anchor': 'end' }, svg).textContent = String(v);
      }
      // 時刻の目盛り（範囲に応じて 15 秒〜1 分ごと）
      const stepMs = span <= 90000 ? 15000 : span <= 180000 ? 30000 : 60000;
      const firstTick = Math.ceil(t0 / stepMs) * stepMs;
      for (let t = firstTick; t <= now; t += stepMs) {
        if (x(t) < L + 16) continue;
        el('text', { x: x(t), y: H - 4, class: 'lag-tick', 'text-anchor': 'middle' }, svg).textContent = clock(t, stepMs < 60000);
      }

      if (!pts.length && !series.length) {
        el('text', { x: (L + W - R) / 2, y: top.y + top.h / 2, class: 'lag-empty', 'text-anchor': 'middle' }, svg)
          .textContent = '文字起こしを始めると、清書の遅れがここに表示されます';
      }

      // 下段: 清書待ち（ステップの面＋線）
      if (series.length) {
        let v = this.tracker.pendingAt(t0);
        let d = `M${x(t0)},${yBot(v)}`;
        for (const p of series) {
          if (p.t < t0) continue;
          d += ` H${x(p.t)} V${yBot(p.v)}`;
          v = p.v;
        }
        d += ` H${x(now)}`;
        el('path', { d: `${d} V${yBot(0)} H${x(t0)} Z`, class: 'lag-area' }, svg);
        el('path', { d, class: 'lag-step' }, svg);
      }

      // 上段の線: 最も古い清書待ちの待ち時間。変化点の間は傾き 1（1 秒に 1 秒）で増え、変化点で上下する
      if (series.length) {
        const changes = series.filter((p) => p.t > t0 && p.t <= now).map((p) => p.t);
        const knots = [t0, ...changes, now];
        let d = `M${x(t0)},${yTop(this.tracker.waitAt(t0))}`;
        for (let i = 1; i < knots.length; i++) {
          const tk = knots[i];
          d += ` L${x(tk)},${yTop(this.tracker.waitAt(tk - 1))}`; // 変化の直前まで増える
          d += ` L${x(tk)},${yTop(this.tracker.waitAt(tk))}`; // 変化点で下がる（または上がる）
        }
        el('path', { d, class: 'lag-line' }, svg);
      }
      // 上段の点: 清書が届いたときの遅れ
      for (const p of pts) el('circle', { cx: x(p.t), cy: yTop(p.delay), r: 4, class: 'lag-dot' }, svg);

      // ホバー用の縦線（両段にまたがる）
      this.cross = el('line', { x1: 0, x2: 0, y1: top.y - 4, y2: bot.y + bot.h, class: 'lag-cross', visibility: 'hidden' }, svg);
      this.focusDot = el('circle', { r: 6, class: 'lag-focus', visibility: 'hidden' }, svg);
    }

    /** ホバー: 縦線を最寄りの清書の位置へ吸着し、遅れと清書待ちをまとめて表示する */
    hover(e) {
      if (!e || !this.geom) {
        this.tip.hidden = true;
        if (this.cross) this.cross.setAttribute('visibility', 'hidden');
        if (this.focusDot) this.focusDot.setAttribute('visibility', 'hidden');
        return;
      }
      const g = this.geom;
      const rect = this.svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * g.W;
      if (px < g.L || px > g.W - g.R) { this.hover(null); return; }
      let t = g.t0 + ((px - g.L) / (g.W - g.L - g.R)) * (g.now - g.t0);
      // 近く（24px 以内）に清書の点があればそこへ吸着する
      let near = null;
      for (const p of this.tracker.points) {
        if (p.t < g.t0) continue;
        const dx = Math.abs(g.x(p.t) - px);
        if (dx <= 24 && (!near || dx < near.dx)) near = { p, dx };
      }
      if (near) t = near.p.t;
      const cx = g.x(t);
      this.cross.setAttribute('x1', cx);
      this.cross.setAttribute('x2', cx);
      this.cross.setAttribute('visibility', 'visible');
      if (near) {
        this.focusDot.setAttribute('cx', cx);
        this.focusDot.setAttribute('cy', g.yTop(near.p.delay));
        this.focusDot.setAttribute('visibility', 'visible');
      } else {
        this.focusDot.setAttribute('visibility', 'hidden');
      }
      // ツールチップ（値を強調し、ラベルは控えめに）
      this.tip.textContent = '';
      const time = document.createElement('div');
      time.className = 'lag-tip-time';
      time.textContent = clock(t);
      this.tip.appendChild(time);
      const row = (key, value, label) => {
        const r = document.createElement('div');
        r.className = 'lag-tip-row';
        const k = document.createElement('span');
        k.className = `lag-key ${key}`;
        const b = document.createElement('b');
        b.textContent = value;
        const s = document.createElement('span');
        s.textContent = label;
        r.append(k, b, s);
        this.tip.appendChild(r);
      };
      row('k-line', fmtSec(this.tracker.waitAt(t)), '最も古い清書待ちの待ち時間');
      if (near) row('k-dot', fmtSec(near.p.delay), `清書が届いたときの遅れ（速報 ${near.p.count} 件をまとめて清書）`);
      row('k-area', `${this.tracker.pendingAt(t)} 件`, '清書待ち');
      this.tip.hidden = false;
      // データに重ならないよう、カーソルが右半分なら左側、左半分なら右側に出す
      const plotW = rect.width;
      const left = (cx / g.W) * plotW;
      const w = this.tip.offsetWidth;
      const pos = left > plotW / 2 ? left - w - 14 : left + 14;
      this.tip.style.left = `${Math.min(Math.max(4, pos), plotW - w - 4)}px`;
      this.tip.style.top = '24px'; // 上段の見本（凡例）に重ならない位置
    }
  }

  return { RefineLagTracker, RefineLagChart, niceMax };
});
