/*
 * 文字起こし結果の表示部品。
 * - TranscriptModel: hayamimi のイベントから結果リストを組み立てる（DOM 非依存・テスト対象）
 * - TranscriptView : モデルの内容を画面に描画する
 *
 * 文字起こし結果は必ず textContent で描画し、HTML として解釈させない。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 時刻表記（ブラウザは window.HMTime、Node.js は require）
  const HMTime = (typeof self !== 'undefined' && self.HMTime)
    || (typeof require === 'function' ? require('../shared/timefmt') : null);

  /**
   * イベントから時刻情報を取り出す。t（実時刻）→ start_s（経過）の順。
   * clockFallback が真なら、どちらもないときに受信時刻を実時刻として使う（リアルタイム用）。
   */
  function timeOf(event, clockFallback) {
    if (event.t != null) return { t: Number(event.t), startS: event.start_s ?? null };
    if (event.start_s != null) return { t: null, startS: Number(event.start_s) };
    return { t: clockFallback ? Date.now() / 1000 : null, startS: null };
  }

  /**
   * 話者ラベル（S1, S2?, …）から色番号（0〜7）を得る。暫定表示の「?」は同じ話者として扱う。
   * @returns {number|null}
   */
  function speakerColorIndex(speaker) {
    const m = /(\d+)/.exec(String(speaker || ''));
    if (!m) return null;
    return (Number(m[1]) - 1 + 8) % 8;
  }

  /** 保存・コピー用に、時刻ラベルを付けたエントリー配列を作る */
  function withTimeLabels(entries, showTime) {
    const label = (e) => (showTime && HMTime ? HMTime.timeLabel(e) : '');
    return entries.map((e) => ({ ...e, time: label(e) }));
  }

  class TranscriptModel {
    /** @param {{clockFallback?: boolean}} [opts] */
    constructor(opts = {}) {
      this.clockFallback = !!opts.clockFallback;
      this.clear();
    }

    clear() {
      this.partial = '';
      this.finals = [];
      this.refined = [];
    }

    /**
     * イベントを適用する。
     * @returns {{kind: string, entry?: object, list?: string} | null} 画面更新に必要な変更内容
     */
    apply(event) {
      if (!event || typeof event !== 'object') return null;
      switch (event.type) {
        case 'partial':
          this.partial = String(event.text || '');
          return { kind: 'partial' };
        case 'final': {
          if (!event.text || !String(event.text).trim()) return null;
          const entry = {
            text: String(event.text),
            lang: event.lang || '',
            speaker: event.speaker || '',
            latency: event.latency_ms != null ? Math.round(event.latency_ms) : null,
            translations: [],
            segId: event.seg_id ?? null,
            refined: false, // 清書に取り込まれたら true
            ...timeOf(event, this.clockFallback),
          };
          this.finals.push(entry);
          this.partial = '';
          return { kind: 'add', list: 'finals', entry };
        }
        case 'translation': {
          const last = this.finals[this.finals.length - 1];
          if (!last || !event.text) return null;
          last.translations.push({ lang: event.lang || '', text: String(event.text) });
          return { kind: 'update', list: 'finals', entry: last };
        }
        case 'refine': {
          if (!event.text || !String(event.text).trim()) return null;
          const entry = {
            text: String(event.text),
            lang: event.lang || '',
            speaker: event.speaker || '',
            translations: [],
            ...timeOf(event, this.clockFallback),
          };
          this.refined.push(entry);
          // この清書がまとめた速報に「清書済み」の印を付ける
          const covered = [];
          if (Array.isArray(event.covers)) {
            const ids = new Set(event.covers);
            for (const f of this.finals) {
              if (f.segId != null && ids.has(f.segId) && !f.refined) {
                f.refined = true;
                covered.push(f);
              }
            }
          }
          return { kind: 'add', list: 'refined', entry, covered };
        }
        case 'hm_refine_skipped': {
          // 清書が出ずに終わった速報（極端に短い等）。速報の文がそのまま最終結果になる
          const ids = new Set(event.covers || []);
          const covered = this.finals.filter((f) => f.segId != null && ids.has(f.segId) && !f.refined);
          covered.forEach((f) => { f.refined = 'skipped'; });
          if (!covered.length) return null;
          // 清書が出なかった発言は、速報の文をそのまま清書タブにも載せる（清書タブだけで全文がそろうように）
          const moved = covered.map((f) => ({ ...f, translations: [...f.translations], skipped: true }));
          this.refined.push(...moved);
          return { kind: 'marks', covered, moved };
        }
        default:
          return null;
      }
    }

    /** 保存・コピー用の配列（清書がなければリアルタイム結果） */
    entries(list) {
      if (list === 'refined') return this.refined;
      if (list === 'finals') return this.finals;
      return this.refined.length ? this.refined : this.finals;
    }

    toPlainText(list, showTime = false) {
      return withTimeLabels(this.entries(list), showTime)
        .map((e) => (e.time ? `[${e.time}] ` : '') + (e.speaker ? `[${e.speaker}] ` : '') + e.text
          + e.translations.map((t) => `\n  (→${t.lang}) ${t.text}`).join(''))
        .join('\n');
    }
  }

  class TranscriptView {
    /**
     * @param {HTMLElement} host 描画先
     * @param {object} handlers { onSave(entries, format), onCopy(text), onNotify(msg), confirmClear() }
     * @param {{clockFallback?: boolean}} [opts]
     */
    constructor(host, handlers = {}, opts = {}) {
      const tpl = document.getElementById('tpl-transcript');
      host.appendChild(tpl.content.cloneNode(true));
      this.root = host.querySelector('.transcript');
      this.model = new TranscriptModel(opts);
      this.showTime = true;
      this.handlers = handlers;
      this.activeTab = 'finals';
      this.nodes = new Map(); // entry -> element
      this.lists = {
        finals: this.root.querySelector('[data-list="finals"]'),
        refined: this.root.querySelector('[data-list="refined"]'),
      };
      this.counts = {
        finals: this.root.querySelector('[data-tab="finals"] .count'),
        refined: this.root.querySelector('[data-tab="refined"] .count'),
      };
      this.idleTimer = null;
      // 末尾を見ているか（新しい結果で自動スクロールするか）。結果が届くたびに位置を読むと
      // 画面全体の配置計算が走り、件数が増えるほど重くなるため、利用者がスクロールしたときだけ更新する
      this.stickBottom = { finals: true, refined: true };
      this.autoScrolling = { finals: false, refined: false };
      for (const [key, el] of Object.entries(this.lists)) {
        el.addEventListener('scroll', () => {
          // アプリ自身の自動スクロールでは位置を読まない（末尾を見ている状態のまま）
          if (this.autoScrolling[key]) { this.autoScrolling[key] = false; return; }
          this.stickBottom[key] = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }, { passive: true });
      }
      this.scrollQueued = new Set();
      this.removeQueue = [];
      this.frameQueued = false;

      this.root.querySelectorAll('.tab').forEach((btn) => {
        btn.addEventListener('click', () => this.showTab(btn.dataset.tab));
      });
      this.root.querySelector('[data-act="copy"]').addEventListener('click', () => {
        const text = this.model.toPlainText(this.activeTab, this.showTime);
        if (handlers.onCopy) handlers.onCopy(text);
      });
      this.root.querySelector('[data-act="save-txt"]').addEventListener('click', () => this.save('txt'));
      this.root.querySelector('[data-act="save-md"]').addEventListener('click', () => this.save('md'));
      this.root.querySelector('[data-act="clear"]').addEventListener('click', async () => {
        if (!this.model.finals.length && !this.model.refined.length) return;
        // 誤操作で消さないよう、確認してからクリアする
        const ok = handlers.confirmClear ? await handlers.confirmClear() : true;
        if (ok) this.clear();
      });
      const timeToggle = this.root.querySelector('[data-act="time"]');
      timeToggle.addEventListener('change', () => {
        this.setShowTime(timeToggle.checked);
        if (handlers.onShowTimeChange) handlers.onShowTimeChange(timeToggle.checked);
      });
    }

    save(format) {
      const entries = this.model.entries(this.activeTab);
      if (!entries.length) {
        if (this.handlers.onNotify) this.handlers.onNotify('保存する文字起こし結果がありません');
        return;
      }
      if (this.handlers.onSave) this.handlers.onSave(withTimeLabels(entries, this.showTime), format);
    }

    /** 時刻の表示・保存の切り替え */
    setShowTime(on) {
      this.showTime = !!on;
      this.root.querySelector('[data-act="time"]').checked = this.showTime;
      this.root.classList.toggle('hide-time', !this.showTime);
    }

    showTab(name) {
      this.activeTab = name;
      this.root.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
      for (const [key, el] of Object.entries(this.lists)) el.hidden = key !== name;
      this.root.querySelectorAll('.tab-help').forEach((h) => { h.hidden = h.dataset.help !== name; });
      if (this.lists[name]) this.scrollToEnd(name); // 隠れている間に増えた分も、末尾を見ていたなら最新を表示
    }

    clear() {
      this.model.clear();
      this.nodes.clear();
      this.provisionalEl = null;
      this.removeQueue.length = 0;
      this.root.classList.remove('has-speaker');
      this.stickBottom = { finals: true, refined: true };
      for (const el of Object.values(this.lists)) {
        el.querySelectorAll('.line').forEach((n) => n.remove());
        const empty = el.querySelector('.empty');
        if (empty) empty.hidden = false;
      }
      this.updateCounts();
      this.setPartial('');
    }

    /**
     * 状態が変わったとき（「停止中」「待機中」「聞き取り中」など）。状態の文字はサイドバーと案内文に出すので、
     * ここでは取り込み中でなくなったら聞き取り途中の仮の行を消すだけ。
     * @param {string} label 状態（記録用）
     * @param {boolean} active 音声を取り込み中・処理中か（聞き取り途中の文字を表示する状態か）
     */
    setStatus(label, active) {
      this.status = label;
      if (!active) this.setPartial('');
    }

    /** 聞き取り途中の文字（速報の一覧の末尾の仮の行に表示。4 秒更新がなければ消す） */
    setPartial(text) {
      clearTimeout(this.idleTimer);
      if (text) {
        this.idleTimer = setTimeout(() => {
          // 速報にならないまま聞き取り途中の文字が止まった（取りこぼしの調査用に知らせる）
          const shown = this.provisionalEl ? this.provisionalEl.querySelector('.line-text').textContent : '';
          this.renderProvisional('');
          if (shown && this.handlers.onPartialDropped) this.handlers.onPartialDropped(shown, 'timeout');
        }, 4000);
      }
      this.renderProvisional(text);
    }

    /** 今表示している聞き取り途中の文字（なければ空） */
    provisionalText() {
      return this.provisionalEl ? this.provisionalEl.querySelector('.line-text').textContent : '';
    }

    /**
     * 聞き取り途中の文字を、速報の一覧の末尾に仮の行として表示する。
     * 速報は一区切り（話し終わり）ごとにしか出ないため、話している間も一覧に文字が出るようにする。
     * 速報が届くと setPartial('') で消え、確定した速報の行に置き換わる。
     */
    renderProvisional(text) {
      const list = this.lists.finals;
      if (!text) {
        if (this.provisionalEl) {
          this.provisionalEl.remove();
          this.provisionalEl = null;
          const empty = list.querySelector('.empty');
          if (empty && !list.querySelector('.line')) empty.hidden = false;
        }
        return;
      }
      if (!this.provisionalEl) {
        const el = document.createElement('div');
        el.className = 'line provisional';
        el.innerHTML = '<div class="line-meta"><span class="provisional-label">聞き取り中</span></div>'
          + '<div class="line-body"><div class="line-text"></div></div>';
        this.provisionalEl = el;
      }
      this.provisionalEl.querySelector('.line-text').textContent = text;
      if (list.lastElementChild !== this.provisionalEl) list.appendChild(this.provisionalEl);
      const empty = list.querySelector('.empty');
      if (empty) empty.hidden = true;
      this.scrollToEnd('finals');
    }

    updateCounts() {
      // 速報タブは清書待ちの件数、清書タブは清書の件数
      this.counts.finals.textContent = this.model.finals.filter((f) => !f.refined).length;
      this.counts.refined.textContent = this.model.refined.length;
    }

    appendLine(listName, entry) {
      const list = this.lists[listName];
      const el = document.createElement('div');
      el.className = 'line arriving';
      this.renderEntry(entry, el);
      this.nodes.set(entry, el);
      const empty = list.querySelector('.empty');
      if (empty) empty.hidden = true;
      if (this.provisionalEl && this.provisionalEl.parentNode === list) list.insertBefore(el, this.provisionalEl);
      else list.appendChild(el);
      return el;
    }

    /** 自動スクロールと消える行の準備を、次の描画の直前に 1 回にまとめて行う（配置計算を 1 コマ 1 回にする） */
    queueFrame() {
      if (this.frameQueued) return;
      this.frameQueued = true;
      const run = () => {
        this.frameQueued = false;
        const removals = this.removeQueue.splice(0).filter(({ el }) => el.isConnected);
        if (removals.length) {
          // 1) 高さをまとめて読み取る → 2) 現在の高さを指定 → 3) 配置を 1 回だけ確定 → 4) 縮め始める
          // （高さの指定と縮め始めを同じタイミングにすると、縮み始めの高さが無く一気に縮んでしまう）
          const heights = removals.map(({ el }) => el.getBoundingClientRect().height);
          removals.forEach(({ el }, i) => { el.style.maxHeight = `${heights[i]}px`; });
          void this.lists.finals.offsetHeight;
          removals.forEach((r) => this.startLeaving(r.el));
        }
        for (const key of this.scrollQueued) {
          const list = this.lists[key];
          if (this.stickBottom[key] && list.scrollTop !== list.scrollHeight - list.clientHeight) {
            this.autoScrolling[key] = true;
            list.scrollTop = list.scrollHeight;
          }
        }
        this.scrollQueued.clear();
      };
      if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run);
      else setTimeout(run, 0);
    }

    scrollToEnd(listName) {
      this.scrollQueued.add(listName);
      this.queueFrame();
    }

    /** 清書が終わった速報を、アニメーションをつけて速報タブから消す */
    removeFinal(entry) {
      const el = this.nodes.get(entry);
      if (!el || el.classList.contains('leaving')) return;
      this.nodes.delete(entry);
      this.removeQueue.push({ el }); // 複数行も同時に消す（ずらすと下の行が段階的に遅れて動いて見える）
      this.queueFrame();
    }

    startLeaving(el) {
      el.style.maxHeight = '0px'; // 指定済みの現在の高さから 0 へ縮める（トランジション）
      el.classList.remove('arriving');
      el.classList.add('leaving');
      const done = () => {
        el.remove();
        const list = this.lists.finals;
        const empty = list.querySelector('.empty');
        if (empty && !list.querySelector('.line')) empty.hidden = false;
      };
      el.addEventListener('transitionend', (e) => { if (e.propertyName === 'max-height') done(); });
      setTimeout(() => { if (el.isConnected) done(); }, 800); // 念のため（アニメーションの全長 0.45 秒より長く）
    }

    renderEntry(entry, el) {
      el.textContent = '';
      const color = speakerColorIndex(entry.speaker);
      if (color === null) delete el.dataset.spk;
      else el.dataset.spk = String(color);
      const meta = document.createElement('div');
      meta.className = 'line-meta';
      const label = HMTime ? HMTime.timeLabel(entry) : '';
      if (label) {
        const tm = document.createElement('span');
        tm.className = 'line-time';
        tm.textContent = label;
        meta.appendChild(tm);
      }
      if (entry.lang) {
        const b = document.createElement('span');
        b.className = `lang lang-${entry.lang}`;
        b.textContent = entry.lang;
        meta.appendChild(b);
      }
      if (entry.speaker) {
        this.root.classList.add('has-speaker');
        const s = document.createElement('span');
        s.className = 'speaker';
        s.textContent = entry.speaker;
        meta.appendChild(s);
      }
      const body = document.createElement('div');
      body.className = 'line-body';
      const text = document.createElement('div');
      text.className = 'line-text';
      text.textContent = entry.text;
      body.appendChild(text);
      for (const t of entry.translations) {
        const tr = document.createElement('div');
        tr.className = 'line-trans';
        tr.textContent = `→${t.lang} ${t.text}`;
        body.appendChild(tr);
      }
      el.append(meta, body);
      const side = document.createElement('div');
      side.className = 'line-side';
      if (entry.latency != null) {
        const lat = document.createElement('div');
        lat.className = 'line-lat';
        lat.textContent = `${entry.latency}ms`;
        side.appendChild(lat);
      }
      // 速報のうち、まだ清書に取り込まれていない行に「清書待ち」を表示する（清書されたら行ごと消える）
      if (entry.segId != null && !entry.refined) {
        const st = document.createElement('div');
        st.className = 'refine-state';
        st.textContent = '清書待ち';
        side.appendChild(st);
      }
      if (entry.skipped) {
        const st = document.createElement('div');
        st.className = 'refine-state skipped';
        st.textContent = '速報のまま';
        st.title = '極端に短い発言などで清書が行われなかったため、速報の文を載せています';
        side.appendChild(st);
      }
      if (side.childElementCount) el.appendChild(side);
    }

    /** hayamimi のイベントを受け取って描画する */
    handle(event) {
      const change = this.model.apply(event);
      if (!change) return;
      if (change.kind === 'partial') {
        this.setPartial(this.model.partial);
        return;
      }
      if (change.kind === 'marks') {
        change.covered.forEach((f) => this.removeFinal(f));
        for (const e of change.moved || []) this.appendLine('refined', e);
        this.updateCounts();
        if ((change.moved || []).length) this.scrollToEnd('refined');
        return;
      }
      if (change.kind === 'add') {
        this.appendLine(change.list, change.entry);
        if (change.list === 'finals') this.setPartial('');
        // 清書に取り込まれた速報は、速報タブからふわっと消す
        (change.covered || []).forEach((f) => this.removeFinal(f));
      } else if (change.kind === 'update') {
        const el = this.nodes.get(change.entry);
        if (el) this.renderEntry(change.entry, el);
      }
      this.updateCounts();
      if (change.kind === 'add') this.scrollToEnd(change.list);
    }
  }

  return { TranscriptModel, TranscriptView, withTimeLabels, speakerColorIndex };
});
