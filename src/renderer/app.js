/* HayamimiWrapper 画面制御 */
(function () {
  'use strict';

  const api = window.hayamimi;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    info: null,
    settings: null,
    status: null,
    engine: 'idle', // idle | starting | running | stopping
    job: null, // 'live' | 'file'
    filePath: null,
    fileStartedAt: 0,
    fileTimer: null,
    devicesLoaded: false,
  };

  /* ---------- 共通 ---------- */

  function toast(message, kind = 'info', ms = 4500) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('hide'), ms);
    setTimeout(() => el.remove(), ms + 400);
  }

  function errorMessage(err) {
    // IPC 経由のエラーは「Error invoking remote method 'x': Error: 本文」形式になる
    const msg = (err && err.message) || String(err);
    return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  /** よくあるエラーを、対処方法つきの分かりやすい文に置き換える */
  function friendlyError(message) {
    const msg = String(message || '');
    if (/PortAudio library not found/i.test(msg)) {
      return 'マイクを使うための PortAudio が見つかりません。Linux では「sudo apt install libportaudio2」を実行してください。';
    }
    if (/Error querying device|Invalid device|No such device|couldn't open microphone|PortAudioError/i.test(msg)) {
      return 'マイク（音声デバイス）を開けませんでした。接続とマイクの選択、Windows の「設定」→「プライバシーとセキュリティ」→「マイク」で'
        + 'デスクトップ アプリのアクセスが ON になっているかを確認してください。';
    }
    return msg;
  }

  // 文字起こし中でも開ける画面（文字起こし中の画面そのものに加えて）
  const ALWAYS_OPEN_PAGES = ['guide', 'log', 'license', 'thanks'];

  function showPage(name) {
    const nav = $(`.nav-item[data-page="${name}"]`);
    if (nav && nav.disabled) {
      toast('文字起こし中は、この画面に切り替えられません。停止してから開いてください。', 'warn', 3000);
      return;
    }
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
    if (name === 'live' && !state.devicesLoaded && state.status && state.status.ready) loadDevices();
  }

  function appendLog(pre, text, level) {
    const line = document.createElement('div');
    line.className = `log-line ${level || ''}`;
    line.textContent = text;
    pre.appendChild(line);
    while (pre.childElementCount > 3000) pre.firstChild.remove();
    pre.scrollTop = pre.scrollHeight;
  }

  /** hayamimi の出力の種類（聞き取り途中・速報・清書・それ以外） */
  function engineLineKind(text) {
    if (/^~ /.test(text)) return 'k-partial';
    if (/^\[refine\//.test(text)) return 'k-refine';
    if (/^\[(?:[^\]|]*\|)?[a-z]{2,3}\/[^\]]+\]/i.test(text)) return 'k-final';
    return 'k-engine';
  }

  /**
   * ログ画面に 1 行出す。source: 'app'（アプリのメッセージ）| 'engine'（hayamimi の出力）。
   * アプリのメッセージは左の帯と「アプリ」の印で、hayamimi の出力は種類ごとの文字色で見分けられるようにする
   */
  function engineLog(text, level, source = 'app') {
    const kind = source === 'engine' ? engineLineKind(String(text)) : `k-app${level === 'stderr' ? ' warn' : ''}`;
    appendLog($('#engine-log'), text, `${level || ''} ${kind}`);
  }

  /* ---------- 実行状態 ---------- */

  // リアルタイム: idle → loading → ready ⇄ (opening →) capturing → pausing → ready … → unloading → idle
  // ファイル    : idle → starting → running → (stopping →) idle
  const ENGINE_LABEL = {
    idle: '停止中',
    loading: 'モデル読み込み中…',
    ready: '待機中（読み込み済み）',
    opening: '入力を開いています…',
    capturing: '文字起こし中',
    pausing: '停止しています…',
    unloading: 'モデルを解放中…',
    starting: '準備中…',
    running: '文字起こし中',
    stopping: '停止しています…',
  };

  let slowStartTimer = null;
  // 停止（pausing）が長引いたら、案内を出して「モデルを解放」で強制的に終われるようにする
  const PAUSING_STUCK_MS = 10000;
  let pausingTimer = null;
  let pausingStuck = false;

  // 経過時間: 「● 開始」で取り込みが始まった時刻から数える。停止で止め、次の開始で 0 から
  const elapsed = { startAt: 0, stoppedAt: 0, timer: null };

  function formatHms(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function renderElapsed() {
    const box = $('#live-elapsed');
    const running = elapsed.startAt && !elapsed.stoppedAt;
    const ms = elapsed.startAt ? (elapsed.stoppedAt || Date.now()) - elapsed.startAt : 0;
    $('#live-elapsed-time').textContent = formatHms(ms);
    box.classList.toggle('running', !!running);
    box.classList.toggle('paused', !running && !!elapsed.startAt);
    $('.elapsed-label', box).textContent = running ? '経過' : elapsed.startAt ? '経過（停止中）' : '経過';
  }

  function updateElapsed(prev, next, job) {
    if (job !== 'live') return;
    if (next === 'capturing' && prev !== 'capturing') {
      // 入力の切り替え（capturing のまま）ではリセットしない
      elapsed.startAt = Date.now();
      elapsed.stoppedAt = 0;
      clearInterval(elapsed.timer);
      elapsed.timer = setInterval(renderElapsed, 250);
    } else if (prev === 'capturing' && next !== 'capturing') {
      elapsed.stoppedAt = Date.now();
      clearInterval(elapsed.timer);
    }
    if (next === 'loading') Object.assign(elapsed, { startAt: 0, stoppedAt: 0 });
    renderElapsed();
  }

  function setEngine(next, job) {
    const prevEngine = state.engine;
    const prevJob = state.job;
    state.engine = next;
    if (job !== undefined) state.job = job;
    updateElapsed(prevJob === 'live' ? prevEngine : 'idle', state.job === 'live' ? next : 'idle', 'live');
    if (!(state.job === 'live' && next === 'pausing')) {
      clearTimeout(pausingTimer);
      pausingTimer = null;
      pausingStuck = false;
    } else if (prevEngine !== 'pausing') {
      clearTimeout(pausingTimer);
      pausingStuck = false;
      pausingTimer = setTimeout(() => {
        if (state.job !== 'live' || state.engine !== 'pausing') return;
        pausingStuck = true;
        engineLog('停止の処理が 10 秒以上終わっていません（音声入力の終了待ちの可能性があります）', 'stderr');
        toast('停止に時間がかかっています。しばらく待っても終わらない場合は「モデルを解放」を押してください。', 'warn', 10000);
        setEngine('pausing');
      }, PAUSING_STUCK_MS);
    }
    // モデル読み込みが長引いたら案内を出す
    clearTimeout(slowStartTimer);
    if (next === 'loading' || next === 'starting') {
      slowStartTimer = setTimeout(() => {
        if (state.engine === next) {
          toast('モデルの読み込みに時間がかかっています。「ログ」画面で状況を確認できます。', 'warn', 10000);
        }
      }, 60000);
    }
    const el = $('#engine-state');
    el.dataset.state = next;
    $('.label', el).textContent = ENGINE_LABEL[next];

    const live = state.job === 'live' ? next : 'idle';
    const file = state.job === 'file' ? next : 'idle';
    const ready = isReady();

    // 文字起こし中は、タブ名の横に ● を表示する
    $('#nav-live-live').hidden = live !== 'capturing';
    $('#nav-live-file').hidden = !['starting', 'running'].includes(file);
    updateNavLock(live, file);

    // モデル読み込みボタン
    const loadBtn = $('#btn-load');
    const loadText = {
      idle: 'モデルを読み込む', loading: '読み込みを中止', ready: 'モデルを解放',
      opening: 'モデルを解放', capturing: 'モデルを解放', pausing: 'モデルを解放', unloading: '解放しています…',
    };
    loadBtn.textContent = loadText[live] || 'モデルを読み込む';
    loadBtn.disabled = !ready || file !== 'idle'
      || !(['idle', 'loading', 'ready'].includes(live) || (live === 'pausing' && pausingStuck));
    loadBtn.classList.toggle('loaded', live === 'ready');

    // 開始・停止ボタン（モデル読み込み後のみ押せる）
    const liveBtn = $('#btn-live');
    if (live === 'capturing' || live === 'pausing') {
      liveBtn.textContent = live === 'pausing' ? '停止中…' : '■ 停止';
      liveBtn.classList.add('recording');
      liveBtn.disabled = live === 'pausing';
    } else {
      liveBtn.textContent = live === 'opening' ? '開始中…' : '● 開始';
      liveBtn.classList.remove('recording');
      liveBtn.disabled = live !== 'ready';
    }
    $('#live-hint').textContent = {
      idle: ready ? '「モデルを読み込む」を押し、読み込みが終わったら「開始」を押してください。' : 'まず「セットアップ」を完了してください。',
      loading: 'モデルを読み込んでいます。初回や大きなモデルでは時間がかかります…',
      ready: '準備ができました。「● 開始」ですぐに文字起こしが始まります。入力・会話の種類・言語などは読み込んだままでも変更できます。',
      opening: '音声入力を開いています…',
      capturing: '文字起こし中です。入力・会話の種類・言語などはこのまま変更できます。「■ 停止」で止めてもモデルは読み込んだままです。',
      pausing: pausingStuck
        ? '停止に時間がかかっています。終わらない場合は「モデルを解放」で強制的に終了できます（清書の途中の部分は失われることがあります）。'
        : '停止しています。最後の発言を確定しています…',
      unloading: 'モデルを解放しています（未処理の清書があれば完了させてから終了します）…',
    }[live] || '';

    // ファイル文字起こしボタン（リアルタイムが待機中なら、自動でモデルを解放してから実行）
    const fileBtn = $('#btn-file');
    if (file !== 'idle') {
      fileBtn.textContent = file === 'stopping' ? '中止しています…' : '中止';
      fileBtn.classList.add('recording');
      fileBtn.disabled = file === 'stopping';
    } else {
      fileBtn.textContent = '文字起こし開始';
      fileBtn.classList.remove('recording');
      fileBtn.disabled = !ready || !state.filePath || !['idle', 'ready'].includes(live);
    }

    if (live === 'ready' && !hasInput()) liveBtn.disabled = true;

    // 結果欄上部の状態表示（停止中に「聞き取り中」と出さない）
    if (liveView) {
      const liveStatus = {
        idle: '停止中', loading: 'モデル読み込み中…', ready: '待機中（「● 開始」で聞き取りを始めます）',
        opening: '入力を開いています…', capturing: '聞き取り中', pausing: '停止しています…', unloading: '停止中',
      }[live] || '停止中';
      liveView.setStatus(liveStatus, live === 'capturing');
    }
    if (fileView) {
      const fileStatus = { idle: '停止中', starting: '準備中…', running: '文字起こし中', stopping: '中止しています…' }[file] || '停止中';
      fileView.setStatus(fileStatus, file === 'running');
    }
    if (live !== 'capturing') setLevel(null);

    // 言語・話者などは読み込み時の引数で決まるため、読み込み中はロックする。
    // 入力（マイク / PC の音）とデバイスは読み込み後もいつでも切り替えられる（refreshInputControls）
    // 読み込み後も設定は変えられる（即時反映、または再読み込みの案内）。処理の切り替わり中とファイル処理中だけロックする
    const lockLive = ['loading', 'unloading', 'opening', 'pausing'].includes(live) || file !== 'idle';
    const lockFile = file !== 'idle' || !['idle', 'ready'].includes(live);
    $$('#page-live .controls select:not(.input-ctl), #page-live .controls input:not(.input-ctl)')
      .forEach((c) => { c.disabled = lockLive || c.dataset.lockedByModel === '1'; });
    $$('#page-file .controls select, #page-file .controls input')
      .forEach((c) => { c.disabled = lockFile || c.dataset.lockedByModel === '1'; });
    refreshInputControls();
  }

  /** 文字起こし中は、自身の画面と使い方・ログ・ライセンス・謝辞以外のタブを選べないようにする */
  function updateNavLock(live, file) {
    const own = ['opening', 'capturing', 'pausing'].includes(live) ? 'live'
      : ['starting', 'running', 'stopping'].includes(file) ? 'file' : null;
    $$('.nav-item').forEach((b) => {
      const locked = !!own && b.dataset.page !== own && !ALWAYS_OPEN_PAGES.includes(b.dataset.page);
      b.disabled = locked;
      b.classList.toggle('locked', locked);
      if (locked) b.title = '文字起こし中は切り替えられません（停止すると選べます）';
      else b.removeAttribute('title');
    });
    // 開いていた画面が選べなくなった場合（念のため）は、文字起こし中の画面へ戻す
    const active = $('.nav-item.active');
    if (own && active && active.disabled) showPage(own);
  }

  function hasInput() {
    const run = state.settings.run;
    return !!run.micOn || (!!run.loopbackOn && state.info.platform === 'win32');
  }

  /** 入力（マイク / PC の音）の切り替え欄の有効・無効 */
  function refreshInputControls() {
    $('#mix-note').hidden = !(state.settings.run.micOn && state.settings.run.loopbackOn && state.info.platform === 'win32');
    const live = state.job === 'live' ? state.engine : 'idle';
    const busy = ['loading', 'unloading', 'opening', 'pausing'].includes(live)
      || (state.job === 'file' && state.engine !== 'idle');
    const run = state.settings.run;
    const isWin = state.info.platform === 'win32';
    $('[data-run="micOn"]').disabled = busy;
    $('#live-mic').disabled = busy || !run.micOn;
    $('#btn-refresh-devices').disabled = busy;
    $('#live-loopback').disabled = busy || !isWin;
    $('#live-speaker').disabled = busy || !isWin || !run.loopbackOn;
  }

  /** 入力の ON/OFF・デバイスが変わったとき。取り込み中ならすぐに切り替える */
  async function onInputChanged() {
    refreshInputControls();
    if (state.job !== 'live') { setEngine(state.engine); return; }
    try {
      if (state.engine === 'capturing') {
        if (!hasInput()) {
          setEngine('pausing');
          await api.setCapture(false);
          toast('入力がすべて OFF になったため、文字起こしを停止しました', 'warn');
        } else {
          await api.setCapture(state.settings.run);
        }
      } else {
        setEngine(state.engine);
      }
    } catch (e) { toast(errorMessage(e), 'error'); }
  }

  // ピークホールド: バー（RMS）が届いた最高位置を 1.5 秒保持し、その後は毎秒 20 dB ずつ下げる。
  // ※ 波形の瞬間最大値（サンプルピーク）は RMS より 10〜15 dB 大きく、印がバーの届かない位置に出てしまうため使わない
  const PEAK_HOLD_MS = 1500;
  const PEAK_FALL_DB_PER_S = 20;
  const meterState = { peakDb: -60, peakAt: 0, lastAt: 0 };

  /** 入力レベルメーター（rms は 0〜1。null で消灯） */
  function setLevel(rms) {
    const meter = $('#level-meter');
    const toDb = (v) => Math.max(-60, 20 * Math.log10(Math.max(v, 1e-5)));
    const toPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    if (rms == null) {
      meter.classList.remove('active');
      $('#level-bar').style.width = '0';
      $('#level-peak').style.left = '0';
      $('#level-db').textContent = '—';
      Object.assign(meterState, { peakDb: -60, peakAt: 0, lastAt: 0 });
      return;
    }
    const now = performance.now();
    const rmsDb = toDb(rms);
    if (rmsDb >= meterState.peakDb) {
      meterState.peakDb = rmsDb;
      meterState.peakAt = now;
    } else if (now - meterState.peakAt > PEAK_HOLD_MS) {
      const dt = (now - (meterState.lastAt || now)) / 1000;
      meterState.peakDb = Math.max(rmsDb, meterState.peakDb - PEAK_FALL_DB_PER_S * dt);
    }
    meterState.lastAt = now;
    meter.classList.add('active');
    meter.style.setProperty('--meter-full', `${meter.clientWidth}px`);
    $('#level-bar').style.width = `${toPct(rmsDb)}%`;
    $('#level-peak').style.left = `calc(${toPct(meterState.peakDb)}% - 2px)`;
    $('#level-db').textContent = rmsDb <= -59 ? '-∞ dB' : `${rmsDb.toFixed(0)} dB`;
    $('#level-meter').title = `音量 ${rmsDb.toFixed(0)} dB ／ 直近の最大 ${meterState.peakDb.toFixed(0)} dB（1.5 秒保持）`;
  }

  function isReady() {
    return !!(state.status && state.status.ready);
  }

  /* ---------- 設定（実行オプション） ---------- */

  let saveTimer = null;
  function saveRun() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api.updateSettings({ run: state.settings.run }).catch((e) => toast(errorMessage(e), 'error'));
    }, 300);
  }

  function readControl(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return el.value === '' ? null : Number(el.value);
    return el.value;
  }

  /* ---------- 設定欄の折りたたみ（小さいウィンドウでも結果を広く見られるように） ---------- */

  function renderOptSummary() {
    const run = state.settings.run;
    const input = [run.micOn ? 'マイク' : '', run.loopbackOn && state.info.platform === 'win32' ? 'PC の音' : ''].filter(Boolean).join('＋') || '入力なし';
    const lang = { auto: '言語 自動', ja: '日本語', en: '英語' }[run.langMode] || run.langMode;
    const spk = run.speakers ? `話者の区別 ${run.speakerCount && !['auto', 'many'].includes(String(run.speakerCount)) ? `${run.speakerCount} 人` : 'ON'}` : '';
    $('#live-opt-summary').textContent = [input, `会話の種類: ${P.getProfile(run.profile).label}`, lang, spk].filter(Boolean).join(' ／ ');
  }

  function setOptCollapsed(target, collapsed) {
    const area = document.getElementById(target);
    const btn = $(`.opt-toggle[data-opt-target="${target}"]`);
    area.hidden = collapsed;
    area.closest('.controls').classList.toggle('collapsed', collapsed);
    btn.textContent = collapsed ? '設定を表示 ▼' : '設定を隠す ▲';
    const summary = $('#live-opt-summary');
    if (summary && target === 'live-opt') summary.hidden = !collapsed;
    try { localStorage.setItem(`hmw.collapsed.${target}`, collapsed ? '1' : '0'); } catch { /* 保存できなくても動作には影響しない */ }
  }

  function bindOptToggles() {
    $$('.opt-toggle').forEach((btn) => {
      const target = btn.dataset.optTarget;
      btn.addEventListener('click', () => setOptCollapsed(target, !document.getElementById(target).hidden));
      let saved = '0';
      try { saved = localStorage.getItem(`hmw.collapsed.${target}`) || '0'; } catch { /* 無視 */ }
      setOptCollapsed(target, saved === '1');
    });
  }

  /* ---------- 会話の種類（認識プロファイル） ---------- */

  const P = window.HMProfiles;

  function populateProfiles() {
    $$('.profile-select').forEach((sel) => {
      sel.textContent = '';
      for (const p of P.PROFILES) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.label;
        o.title = p.description;
        sel.appendChild(o);
      }
    });
    const from = $('#profile-copy-from');
    from.textContent = '';
    for (const p of P.PROFILES.filter((x) => x.id !== 'custom')) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      from.appendChild(o);
    }
    // 値の一覧（カスタムのときだけ編集できる）
    const table = $('#profile-table');
    table.textContent = '';
    const rows = [...Object.entries(P.RANGES), ['refine', { label: '清書（2 回目の高精度認識）', help: '前後の音声をまとめてもう一度認識し、より正確な文章にします。CPU の負荷が高い場合は OFF にすると軽くなります。' }]];
    for (const [key, r] of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('td');
      th.textContent = r.label;
      const td = document.createElement('td');
      let input;
      if (key === 'refine') {
        input = document.createElement('input');
        input.type = 'checkbox';
      } else {
        input = document.createElement('input');
        input.type = 'number';
        Object.assign(input, { min: r.min, max: r.max, step: r.step });
      }
      input.dataset.tune = key;
      td.appendChild(input);
      if (r.unit) td.appendChild(document.createTextNode(` ${r.unit}`));
      const help = document.createElement('td');
      help.textContent = `${r.help}（既定 ${key === 'refine' ? 'ON' : P.DEFAULT_TUNING[key]}）`;
      tr.append(th, td, help);
      table.appendChild(tr);
      input.addEventListener('change', () => {
        const run = state.settings.run;
        if (run.profile !== 'custom') return;
        const v = key === 'refine' ? input.checked : Number(input.value);
        run.custom = P.sanitizeTuning({ ...run.custom, [key]: v });
        renderProfileCard();
        saveRun();
      });
    }
    $('#btn-profile-copy').addEventListener('click', () => {
      const src = P.getProfile($('#profile-copy-from').value);
      state.settings.run.custom = { ...src.tuning };
      renderProfileCard();
      saveRun();
      toast(`「${src.label}」の値を読み込みました`, 'success', 2500);
    });
  }

  function renderProfileCard() {
    const run = state.settings.run;
    const custom = run.profile === 'custom';
    const t = P.resolveTuning(run);
    $('#profile-desc').textContent = P.getProfile(run.profile).description;
    $$('[data-tune]').forEach((el) => {
      const k = el.dataset.tune;
      if (el.type === 'checkbox') el.checked = !!t[k];
      else el.value = t[k];
      el.disabled = !custom;
      el.closest('tr').classList.toggle('is-changed', t[k] !== P.DEFAULT_TUNING[k]);
    });
    $('#profile-actions').hidden = !custom;
    $$('.profile-select').forEach((sel) => { sel.title = P.getProfile(run.profile).description; });
  }

  /** data-run 属性を持つ入力欄に設定値を反映する（複数画面で同じ値を共有） */
  function syncRunControls() {
    const run = state.settings.run;
    $$('[data-run]').forEach((el) => {
      const v = run[el.dataset.run];
      if (el.type === 'checkbox') el.checked = !!v;
      else if (el.tagName === 'SELECT') {
        if (v && !Array.from(el.options).some((o) => o.value === v)) {
          // 一覧にないデバイス名も保持しておく
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = `${v}（未接続）`;
          el.appendChild(opt);
        }
        el.value = v ?? '';
      } else el.value = v ?? '';
    });
    $$('[data-run-translate]').forEach((el) => { el.checked = !!run.translate; });
    // 清書を行わない設定では「清書待ち」の表示を出さない
    const refineOn = P.resolveTuning(run).refine;
    [liveView, fileView].forEach((v) => { if (v) v.root.classList.toggle('no-refine', !refineOn); });
    renderProfileCard();
    renderOptSummary();
    // 話者の人数は、話者を区別するときだけ選べる
    $$('[data-run="speakerCount"]').forEach((el) => {
      el.hidden = !run.speakers;
    });
    updateInputFields();
  }

  function bindRunControls() {
    $$('[data-run]').forEach((el) => {
      el.addEventListener('change', () => {
        const v = readControl(el);
        if (v === null) return;
        state.settings.run[el.dataset.run] = v;
        syncRunControls();
        saveRun();
        if (el.classList.contains('input-ctl')) onInputChanged();
      });
    });
    $$('[data-run-translate]').forEach((el) => {
      el.addEventListener('change', () => {
        state.settings.run.translate = el.checked ? 'en' : '';
        syncRunControls();
        saveRun();
      });
    });
  }

  function updateInputFields() {
    if (state.info) refreshInputControls();
  }

  /** モデル構成・OS に応じて使えない機能を無効化する */
  function applyCapabilities() {
    const isWin = state.info.platform === 'win32';
    if (!isWin) {
      state.settings.run.loopbackOn = false;
      const label = $('#live-loopback').parentElement;
      if (!label.textContent.includes('Windows')) label.appendChild(document.createTextNode('（Windows のみ）'));
    }

    const full = state.status && state.status.modelSet === 'full';
    $$('[data-run="speakers"], [data-run="speakerCount"], [data-run-translate]').forEach((el) => {
      el.dataset.lockedByModel = full ? '0' : '1';
      el.disabled = !full || state.engine !== 'idle';
      if (!full) el.checked = false;
    });
    if (!full) {
      state.settings.run.speakers = false;
      state.settings.run.translate = '';
    }
    $$('.full-only-note').forEach((n) => { n.hidden = full || !isReady(); });
  }

  /* ---------- セットアップ ---------- */

  const STEP_ICON = { pending: '○', running: '◌', done: '✓', skipped: '✓', error: '✕' };

  function renderSteps(steps) {
    const ol = $('#setup-steps');
    ol.textContent = '';
    for (const s of steps) {
      const li = document.createElement('li');
      li.className = 'step pending';
      li.dataset.step = s.id;
      li.innerHTML = '<span class="step-ico"></span><div class="step-body"><div class="step-label"></div>'
        + '<div class="step-msg"></div><div class="progress thin"><div class="bar"></div></div></div>'
        + '<button class="btn small step-undo" hidden>元に戻す</button>';
      $('.step-ico', li).textContent = STEP_ICON.pending;
      $('.step-label', li).textContent = s.label;
      $('.step-undo', li).addEventListener('click', () => undoStep(s.id, s.label));
      ol.appendChild(li);
    }
  }

  /* ---------- 元に戻す ---------- */

  const UNDO_DETAIL = {
    uv: 'セットアップ用ツール（uv）とそのキャッシュ（ダウンロードしたライブラリ・Python の保管場所）を削除します。\n文字起こしには影響しません。次回のセットアップや「修復」では、ライブラリ等をダウンロードし直します。',
    source: 'hayamimi 本体（プログラム）を削除します。Python 環境とモデルは残ります。\n再度セットアップするまで文字起こしはできません。',
    python: 'Python 環境（仮想環境と、uv が用意した Python 本体）を削除します。\n手順 4 のライブラリも一緒に削除されます。再度セットアップするまで文字起こしはできません。',
    deps: 'Python 環境に入れたライブラリをすべてアンインストールします（Python 環境自体は残ります）。\n再度セットアップするまで文字起こしはできません。',
    models: '音声認識モデルを削除します。\n再度セットアップすると、モデルをダウンロードし直します。',
  };
  let stepSizes = null;

  function formatSize(bytes) {
    if (!bytes) return '0MB';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
    return `${Math.max(1, Math.round(bytes / 1024 ** 2))}MB`;
  }

  /** 各手順の「元に戻す」ボタンと使用容量を表示する */
  async function refreshUndoButtons() {
    const s = state.status;
    if (!s || !s.present) return;
    const busy = s.running || state.engine !== 'idle';
    $$('#setup-steps .step').forEach((li) => {
      const btn = $('.step-undo', li);
      btn.hidden = !s.present[li.dataset.step];
      btn.disabled = busy;
      btn.title = busy ? '文字起こし・セットアップの実行中は元に戻せません' : 'この手順で導入したものを削除します';
    });
    $('#btn-undo-all').disabled = busy || !Object.values(s.present).some(Boolean);
    try {
      stepSizes = await api.setupSizes();
    } catch {
      stepSizes = null;
    }
    if (!stepSizes) return;
    $$('#setup-steps .step').forEach((li) => {
      if (li.classList.contains('running')) return;
      const size = stepSizes[li.dataset.step];
      const msg = $('.step-msg', li);
      msg.textContent = s.present[li.dataset.step] && size ? `使用容量 ${formatSize(size)}` : msg.textContent;
    });
    $('#undo-all-hint').textContent = `各手順の「元に戻す」で、その手順で導入したものを削除できます。保存場所の合計: ${formatSize(stepSizes.all)}`;
  }

  async function undoStep(id, label) {
    const size = stepSizes && stepSizes[id] ? `（約 ${formatSize(stepSizes[id])}）` : '';
    const ok = await api.confirm(`「${label}」を元に戻しますか？${size}`, UNDO_DETAIL[id], '元に戻す');
    if (!ok) return;
    await doUndo(id);
  }

  async function doUndo(id) {
    $$('#setup-steps .step-undo, #btn-undo-all').forEach((b) => { b.disabled = true; });
    try {
      state.status = await api.undoStep(id);
      toast('元に戻しました', 'success');
      state.devicesLoaded = false;
    } catch (e) {
      toast(`元に戻せませんでした: ${errorMessage(e)}`, 'error', 9000);
    }
    renderSteps(state.status.steps);
    markStepsFromStatus(state.status);
    renderSetup();
  }

  function markStepsFromStatus(status) {
    const pr = status.present || {};
    const doneMap = { uv: status.uv, source: status.source, python: status.python, deps: !!pr.deps, models: !!pr.models };
    $$('#setup-steps .step').forEach((li) => {
      const ok = doneMap[li.dataset.step];
      li.className = `step ${ok ? 'done' : 'pending'}`;
      $('.step-ico', li).textContent = ok ? STEP_ICON.done : STEP_ICON.pending;
      $('.step-msg', li).textContent = '';
      $('.bar', li).style.width = '0';
    });
    $('#setup-overall').style.width = status.ready ? '100%' : '0';
  }

  /** セットアップのボタンの名前と説明を、選んでいるモデルとセットアップ済みのモデルの違いに合わせる */
  function updateInstallButton() {
    const s = state.status || {};
    const checked = $('input[name="modelSet"]:checked');
    const chosen = checked ? checked.value : 'minimal';
    let label; let hint = '';
    if (!s.ready) {
      label = 'セットアップを開始';
    } else if (chosen === 'full' && s.modelSet !== 'full') {
      label = 'フル機能のモデルを追加する（約 2GB）';
      hint = '足りないモデルだけをダウンロードします（Python・ライブラリはそのまま使います）。完了すると話者の区別・英訳が使えます。';
    } else if (chosen === 'minimal' && s.modelSet === 'full') {
      label = '標準のモデルに切り替える';
      hint = '話者の区別・英訳は使えなくなります。フル機能のモデル（約 2GB）は保存場所に残り、もう一度「フル機能」を選ぶとすぐ戻せます。';
    } else {
      label = '入れ直して修復する';
      hint = 'うまく動かないときに使います。Python・ライブラリ・モデルのうち、欠けているものや壊れたものを入れ直します。';
    }
    $('#btn-install').textContent = label;
    $('#btn-install').classList.toggle('large', !s.ready);
    // 修復はふだん使わない操作なので、主ボタンの色にはしない（切り替え・追加は主ボタン）
    $('#btn-install').classList.toggle('primary', !s.ready || label !== '入れ直して修復する');
    $('#install-hint').textContent = hint;
    $('#install-hint').hidden = !hint;
  }

  function renderSetup() {
    const s = state.status;
    $('#setup-root').textContent = s.root;
    $('#setup-root-warning').hidden = !s.rootWarning;
    $('#nav-setup-badge').hidden = s.ready;
    $('#setup-ready').hidden = !s.ready;
    if (s.ready) {
      const kind = s.modelSet === 'full' ? 'フル機能' : '標準（日本語・英語）';
      const when = s.installedAt ? new Date(s.installedAt).toLocaleString('ja-JP') : '';
      const ver = s.pinned ? `hayamimi ${s.pinned.hayamimiCommit.slice(0, 7)}（固定）` : '';
      $('#setup-ready-detail').textContent = `モデル: ${kind} ／ ${ver}${when ? ` ／ 導入日時: ${when}` : ''}`;
    }
    const radio = $(`input[name="modelSet"][value="${s.modelSet || state.settings.modelSet || 'minimal'}"]`);
    if (radio && !s.running) radio.checked = true;

    updateInstallButton();
    setInstalling(s.running);
    applyCapabilities();
    setEngine(state.engine);
    refreshUndoButtons();
  }

  function setInstalling(on) {
    $('#btn-install').hidden = on;
    $('#btn-cancel-install').hidden = !on;
    $$('input[name="modelSet"], #btn-choose-root, #btn-reset-root').forEach((el) => { el.disabled = on; });
  }

  async function refreshStatus() {
    state.status = await api.setupStatus();
    markStepsFromStatus(state.status);
    renderSetup();
    return state.status;
  }

  async function runInstall() {
    // モデルを読み込んでいる間（ファイル処理中を含む）は、モデルの切り替え・修復をしない（使用中のファイルを入れ直せないため）
    if (state.job && state.engine !== 'idle') {
      toast('モデルを読み込んでいる間は、モデルの切り替え・修復はできません。「リアルタイム」画面の「モデルを解放」を押してから実行してください。', 'warn', 7000);
      return;
    }
    const modelSet = $('input[name="modelSet"]:checked').value;
    renderSteps(state.status.steps);
    $('#setup-log').textContent = '';
    $('#setup-overall').style.width = '0';
    setInstalling(true);
    $('#setup-progress-card').scrollIntoView({ behavior: 'smooth' });
    try {
      state.status = await api.install({ modelSet });
      toast('セットアップが完了しました。文字起こしを始められます。', 'success');
      state.devicesLoaded = false;
    } catch (e) {
      toast(`セットアップに失敗しました: ${errorMessage(e)}`, 'error', 9000);
      $('.log-details').open = true;
    }
    await refreshStatus();
  }

  function bindSetup() {
    $('#btn-install').addEventListener('click', () => runInstall());
    $$('input[name="modelSet"]').forEach((r) => r.addEventListener('change', updateInstallButton));
    $('#btn-cancel-install').addEventListener('click', () => api.cancelInstall());
    $('#btn-choose-root').addEventListener('click', async () => {
      try {
        state.status = await api.chooseRuntimeRoot();
        renderSteps(state.status.steps);
        markStepsFromStatus(state.status);
        renderSetup();
      } catch (e) { toast(errorMessage(e), 'error'); }
    });
    $('#btn-reset-root').addEventListener('click', async () => {
      try {
        state.status = await api.resetRuntimeRoot();
        renderSteps(state.status.steps);
        markStepsFromStatus(state.status);
        renderSetup();
      } catch (e) { toast(errorMessage(e), 'error'); }
    });
    $('#btn-open-root').addEventListener('click', () => api.openFolder('runtime'));
    $('#btn-undo-all').addEventListener('click', async () => {
      const size = stepSizes ? `（約 ${formatSize(stepSizes.all)}）` : '';
      const ok = await api.confirm(`保存場所をすべて削除しますか？${size}`,
        `${state.status.root}\nを丸ごと削除します（hayamimi 本体・Python 環境・ライブラリ・モデル・uv）。\n`
        + 'アプリの設定（プロキシ・置換辞書など）は残ります。アプリ自体を削除するには、Windows の「設定」→「アプリ」からアンインストールしてください。',
        'すべて削除');
      if (ok) await doUndo('all');
    });

    api.onSetupProgress((p) => {
      const li = $(`#setup-steps .step[data-step="${p.step}"]`);
      if (li) {
        li.className = `step ${p.status}`;
        $('.step-ico', li).textContent = STEP_ICON[p.status] || STEP_ICON.pending;
        if (p.message) $('.step-msg', li).textContent = p.message;
        if (p.status === 'skipped') $('.step-msg', li).textContent = '準備済み';
        if (p.status === 'done' && !p.message) $('.step-msg', li).textContent = '完了';
        $('.bar', li).style.width = p.status === 'running' ? `${p.percent || 0}%` : '0';
      }
      if (p.overall != null) $('#setup-overall').style.width = `${p.overall}%`;
    });
    api.onSetupLog((l) => {
      appendLog($('#setup-log'), l.text, l.level);
      if (l.level === 'error') {
        const running = $('#setup-steps .step.running');
        if (running) {
          running.className = 'step error';
          $('.step-ico', running).textContent = STEP_ICON.error;
        }
      }
    });
  }

  /* ---------- デバイス ---------- */

  function fillSelect(select, items, defaultLabel) {
    const current = select.value;
    select.textContent = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = defaultLabel;
    select.appendChild(def);
    for (const d of items) {
      const o = document.createElement('option');
      o.value = d.name;
      o.textContent = d.default ? `${d.name}（既定）` : d.name;
      select.appendChild(o);
    }
    select.value = current;
  }

  async function loadDevices() {
    if (!isReady()) return;
    const btn = $('#btn-refresh-devices');
    btn.classList.add('spin');
    try {
      const r = await api.listDevices();
      fillSelect($('#live-mic'), r.inputs || [], '既定のマイク');
      fillSelect($('#live-speaker'), r.speakers || [], '既定のスピーカー');
      state.devicesLoaded = true;
      if (r.error) toast(friendlyError(r.error), 'error', 8000);
      syncRunControls();
    } catch (e) {
      toast(errorMessage(e), 'error', 8000);
    } finally {
      btn.classList.remove('spin');
    }
  }

  /* ---------- 文字起こし ---------- */

  let liveView;
  let fileView;
  let lagChart; // 清書の遅れグラフ（リアルタイム）

  function viewFor(job) {
    return job === 'file' ? fileView : liveView;
  }

  async function saveEntries(entries, format, source) {
    try {
      const saved = await api.saveTranscript(entries, format, { source });
      if (saved) toast(`保存しました: ${saved}`, 'success');
    } catch (e) { toast(errorMessage(e), 'error'); }
  }

  async function copyText(text) {
    if (!text) { toast('コピーする内容がありません'); return; }
    try {
      await api.copyText(text);
      toast('クリップボードにコピーしました', 'success', 2000);
    } catch (e) { toast(`コピーに失敗しました: ${e.message}`, 'error'); }
  }

  /** モデルの読み込み / 解放 */
  /* ---------- 読み込み後の設定変更 ---------- */

  let appliedTimer = null;
  function notifyApplied() {
    clearTimeout(appliedTimer);
    appliedTimer = setTimeout(() => toast('設定を反映しました（モデルは読み込んだままです）', 'success', 2500), 400);
  }

  function waitForEngine(pred, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const t = setInterval(() => {
        if (pred()) { clearInterval(t); resolve(); }
        else if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error('時間内に切り替わりませんでした')); }
      }, 100);
    });
  }

  /** 再読み込み: 文字起こし中なら止め、モデルを解放してから読み込み直す */
  async function reloadLive() {
    const btn = $('#btn-reload');
    btn.disabled = true;
    try {
      if (state.job === 'live' && state.engine === 'capturing') {
        setEngine('pausing');
        await api.setCapture(false);
        await waitForEngine(() => state.engine === 'ready');
      }
      if (state.job === 'live' && state.engine === 'ready') {
        setEngine('unloading');
        await api.stop();
        await waitForEngine(() => state.engine === 'idle');
      }
      await toggleLoad();
    } catch (e) {
      toast(`再読み込みできませんでした: ${errorMessage(e)}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function toggleLoad() {
    const live = state.job === 'live' ? state.engine : 'idle';
    if (live === 'loading' || live === 'ready' || (live === 'pausing' && pausingStuck)) {
      setEngine('unloading');
      await api.stop();
      return;
    }
    if (live !== 'idle' || state.engine !== 'idle') return;
    if (!isReady()) { showPage('setup'); return; }
    setEngine('loading', 'live');
    liveView.setPartial('');
    if (lagChart) lagChart.reset();
    try {
      const r = await api.loadLive(state.settings.run);
      if (r && r.transcriptPath) engineLog(`自動保存先: ${r.transcriptPath}`, 'success');
    } catch (e) {
      setEngine('idle', null);
      toast(errorMessage(e), 'error', 8000);
    }
  }

  /** 文字起こしの開始 / 停止（モデルは読み込んだまま） */
  async function toggleLive() {
    if (state.job !== 'live') return;
    try {
      if (state.engine === 'ready') {
        if (!hasInput()) { toast('マイクか PC の音のどちらかを ON にしてください', 'warn'); return; }
        setEngine('opening');
        await api.setCapture(state.settings.run);
      } else if (state.engine === 'capturing') {
        setEngine('pausing');
        await api.setCapture(false);
      }
    } catch (e) {
      toast(errorMessage(e), 'error', 8000);
    }
  }

  function setFile(filePath) {
    state.filePath = filePath;
    $('#file-name').textContent = filePath ? `選択中: ${filePath}` : '';
    $('#dropzone').classList.toggle('has-file', !!filePath);
    setEngine(state.engine);
  }

  function setFileStatus(text, fraction) {
    $('#file-progress').hidden = false;
    $('#file-status').textContent = text;
    const bar = $('#file-bar');
    bar.classList.toggle('indeterminate', fraction == null);
    bar.style.width = fraction == null ? '' : `${Math.round(fraction * 100)}%`;
  }

  function fileBusy() {
    return state.job === 'file' && state.engine !== 'idle';
  }

  async function toggleFile() {
    if (fileBusy()) {
      setEngine('stopping');
      await api.stop();
      return;
    }
    // リアルタイムは「待機中」なら可（モデルは自動で解放される）
    if (state.job === 'live' && state.engine !== 'ready') return;
    if (!state.filePath) return;
    if (!isReady()) { showPage('setup'); return; }
    if (fileView.model.finals.length || fileView.model.refined.length) {
      const ok = await api.confirm('前回の文字起こし結果を消去して開始しますか？',
        '必要な場合は、先に「コピー」や「保存」をしてください。', '消去して開始');
      if (!ok) return;
    }
    fileView.clear();
    setEngine('starting', 'file');
    setFileStatus('音声を変換しています…', 0);
    try {
      const r = await api.startFile(state.filePath, state.settings.run);
      if (r && r.transcriptPath) engineLog(`自動保存先: ${r.transcriptPath}`, 'success');
    } catch (e) {
      setEngine('idle', null);
      setFileStatus(`失敗しました: ${errorMessage(e)}`, 0);
      toast(errorMessage(e), 'error', 8000);
    }
  }

  function formatElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
  }

  function startFileTimer(duration) {
    state.fileStartedAt = Date.now();
    clearInterval(state.fileTimer);
    const total = duration ? `（音声の長さ ${formatElapsed(duration * 1000)}）` : '';
    state.fileTimer = setInterval(() => {
      const n = fileView.model.finals.length;
      const phase = state.engine === 'starting' ? 'モデルを読み込んでいます' : '文字起こし中';
      setFileStatus(`${phase}… 経過 ${formatElapsed(Date.now() - state.fileStartedAt)} ／ ${n} 件${total}`, null);
    }, 500);
  }

  function bindEngine() {
    api.onEvent(({ job, event }) => {
      if (event.type === 'session_start') {
        if (job === 'file') setEngine('running', job);
        return;
      }
      // 途中表示を OFF にしている場合は、途中の文字を表示しない（読み込み後の切り替えもすぐ反映）
      if (event.type === 'partial' && state.settings.run.partial === false) return;
      if (event.type === 'hm_config_applied' && job === 'live' && (event.applied || []).length) {
        if (event.applied.includes('reset_speakers')) toast('話者の番号をリセットしました（次の発言から S1 になります）', 'success', 2500);
        else notifyApplied();
        return;
      }
      if (job === 'live' && lagChart) {
        if (event.type === 'final') lagChart.onFinal(event.seg_id);
        if (event.type === 'refine') lagChart.onRefine(event.covers);
        if (event.type === 'hm_refine_skipped') lagChart.onSkip(event.covers);
      }
      if (job === 'live') {
        if (event.type === 'hm_ready') {
          const first = state.engine === 'loading';
          setEngine('ready', 'live');
          liveView.setPartial('');
          if (first) toast('モデルの読み込みが完了しました。「● 開始」を押すと文字起こしが始まります。', 'success', 5000);
          return;
        }
        if (event.type === 'hm_capture_start') {
          setEngine('capturing', 'live');
          const names = { mic: 'マイク', speaker: 'PC の音', mix: 'マイク ＋ PC の音' };
          engineLog(`入力: ${names[event.input] || event.input}`);
          return;
        }
        if (event.type === 'hm_level') {
          if (state.engine === 'capturing') setLevel(event.rms);
          return;
        }
        if (event.type === 'hm_stall') {
          // hayamimi は認識を 1 本の流れで順に行うため、長い発言の認識中は次の音声に進めない（CPU に空きがあっても起こる）。
          // 止まっている間の音声はためておき、あとで追いつく（マイク＋PC の音は約 10 秒分まで）
          engineLog(`長い発言の認識に時間がかかり、処理が ${(event.ms / 1000).toFixed(1)} 秒止まりました（この間の音声はためておき、あとで追いつきます）`,
            event.ms >= 5000 ? 'stderr' : 'info');
          return;
        }
        if (event.type === 'hm_longseg_split') {
          if (event.accepted) engineLog(`長い区間（${event.audio_s} 秒）を文の切れ目で ${event.pieces} つに分けて認識しました（文の抜け落ちを防ぐため）`, 'info');
          return;
        }
        if (event.type === 'hm_refine_guard') {
          if (event.mode === 'replace') {
            engineLog('清書の文が元の速報より大幅に短かったため（文の抜け落ち）、速報の文を清書として使いました', 'info');
          } else {
            // 清書に無かった速報の文を補った
            engineLog(`清書で抜けていた文を速報の文で補いました: ${(event.added || []).map((t) => `「${t}」`).join(' ')}`, 'info');
          }
          return;
        }
        if (event.type === 'hm_headdrop_retry') {
          // 速報の前半が抜けていたため、区間を分けて認識し直した（取りこぼしの調査用）
          engineLog(event.accepted
            ? `速報の前半が抜けていたため、区間（${event.audio_s} 秒）を分けて認識し直しました: 「${event.before}」→「${event.after}」`
            : `速報の前半が抜けている可能性がありましたが、認識し直しても改善しなかったため元の速報のままにしました（区間 ${event.audio_s} 秒）`, event.accepted ? 'info' : 'stderr');
          return;
        }
        if (event.type === 'hm_final_empty') {
          // 発言の区間を認識した結果が空で、hayamimi が速報を出さなかった（取りこぼしの調査用）
          const shown = liveView.provisionalText();
          engineLog(`速報になりませんでした（区間 ${event.audio_s} 秒を認識した結果が空）${shown ? `: 聞き取り途中は「${shown}」` : ''}`, 'stderr');
          liveView.setPartial('');
          return;
        }
        if (event.type === 'hm_notice') {
          engineLog(event.count > 1 ? `${event.message}（${event.count} 回）` : event.message, 'stderr');
          return;
        }
        if (event.type === 'hm_paused') { liveView.setPartial(''); return; }
        if (event.type === 'hm_capture_error') {
          engineLog(event.message, 'error');
          toast(`音声入力を開けませんでした: ${friendlyError(event.message)}`, 'error', 10000);
          return;
        }
      }
      if (event.type === 'model_load' && event.model) {
        engineLog(`モデル読み込み: ${event.model}${event.ms ? ` (${Math.round(event.ms)}ms)` : ''}`);
      }
      if (event.type === 'warning') {
        toast(`警告: ${event.message || event.code || ''}`, 'warn', 6000);
        engineLog(`警告: ${JSON.stringify(event)}`, 'stderr');
      }
      if (event.type === 'hm_error') {
        engineLog(event.trace || event.message, 'error');
        toast(`エラー: ${friendlyError(event.message)}`, 'error', 9000);
      }
      if (event.type === 'session_summary') {
        engineLog(`セッション概要: ${JSON.stringify(event)}`);
      }
      viewFor(job).handle(event);
    });

    api.onLog(({ text, level, source }) => engineLog(text, level, source || 'app'));

    api.onExit((info) => {
      const job = info.job;
      // 別の処理の終了通知（例: ファイル開始時に待機中のリアルタイムを解放）で状態を消さない
      if (state.job === job || state.job === null) setEngine('idle', null);
      if (job === 'file') {
        clearInterval(state.fileTimer);
        const n = fileView.model.finals.length;
        if (info.code === 0 && !info.stopped) {
          setFileStatus(`完了しました（${n} 件・所要 ${formatElapsed(Date.now() - state.fileStartedAt)}）`, 1);
          toast('ファイルの文字起こしが完了しました', 'success');
        } else if (info.stopped) {
          setFileStatus(`中止しました（${n} 件）`, 0);
        } else {
          setFileStatus('エラーで終了しました。「ログ」画面を確認してください。', 0);
          toast('文字起こしがエラーで終了しました。「ログ」画面を確認してください。', 'error', 9000);
        }
      } else if (!info.stopped && info.code !== 0) {
        toast('文字起こしがエラーで終了しました。「ログ」画面を確認してください。', 'error', 9000);
      }
      engineLog(`hayamimi が終了しました（コード ${info.code ?? info.signal}）`, info.code === 0 ? 'success' : 'stderr');
    });

    api.onFileProgress((p) => {
      if (p.phase === 'convert') setFileStatus(`音声を変換しています… ${Math.round((p.fraction || 0) * 100)}%`, p.fraction || 0);
      if (p.phase === 'transcribe') startFileTimer(p.duration);
    });
  }

  function bindFilePage() {
    const dz = $('#dropzone');
    $('#btn-choose-file').addEventListener('click', async (e) => {
      e.stopPropagation();
      const f = await api.chooseFile();
      if (f) setFile(f);
    });
    dz.addEventListener('click', async () => {
      if (fileBusy()) return;
      const f = await api.chooseFile();
      if (f) setFile(f);
    });
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') dz.click(); });
    ['dragenter', 'dragover'].forEach((t) => dz.addEventListener(t, (e) => {
      e.preventDefault();
      dz.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((t) => dz.addEventListener(t, () => dz.classList.remove('over')));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file || fileBusy()) return;
      const p = api.pathForFile(file);
      const ext = (p.split('.').pop() || '').toLowerCase();
      if (!state.info.mediaExtensions.includes(ext)) toast('対応していない形式かもしれません。変換を試みます。', 'warn');
      setFile(p);
    });
    // ウィンドウ全体へのドロップでページ遷移しないようにする
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
    $('#btn-file').addEventListener('click', toggleFile);
  }

  /* ---------- 設定画面 ---------- */

  function renderProxy() {
    const p = state.settings.proxy || {};
    $$('input[name="proxyMode"]').forEach((r) => { r.checked = r.value === (p.mode || 'system'); });
    $('#proxy-url').value = p.url || '';
    $('#proxy-bypass').value = p.bypass || '';
    $('#proxy-user').value = p.username || '';
    $('#proxy-pass').value = '';
    $('#proxy-pass').placeholder = p.hasPassword ? '（保存済み。変更する場合のみ入力）' : '';
    $('#proxy-pass-hint').textContent = !p.hasPassword ? ''
      : p.passwordEncrypted ? 'パスワードは暗号化して保存されています。'
        : 'この環境では OS の暗号化機能が使えないため、パスワードは符号化のみで保存されています。';
    $('#btn-proxy-clearpass').hidden = !p.hasPassword;
    updateProxyFields();
  }

  function updateProxyFields() {
    const mode = ($('input[name="proxyMode"]:checked') || {}).value || 'system';
    $$('[data-proxy-manual] input').forEach((el) => { el.disabled = mode !== 'manual'; });
    $('#proxy-user').disabled = mode === 'none';
    $('#proxy-pass').disabled = mode === 'none';
  }

  function readProxyForm() {
    const patch = {
      mode: ($('input[name="proxyMode"]:checked') || {}).value || 'system',
      url: $('#proxy-url').value,
      bypass: $('#proxy-bypass').value,
      username: $('#proxy-user').value,
    };
    const pass = $('#proxy-pass').value;
    if (pass) patch.password = pass;
    return patch;
  }

  async function saveProxy(extra = {}) {
    const patch = { ...readProxyForm(), ...extra };
    if (patch.mode === 'manual' && !patch.url.trim()) {
      toast('プロキシのアドレスを入力してください', 'warn');
      return false;
    }
    state.settings = await api.updateSettings({ proxy: patch });
    renderProxy();
    return true;
  }

  async function testProxy() {
    const box = $('#proxy-result');
    const btn = $('#btn-proxy-test');
    if (!(await saveProxy())) return;
    btn.disabled = true;
    box.hidden = false;
    box.textContent = '接続を確認しています…';
    try {
      const r = await api.testProxy();
      box.textContent = '';
      const head = document.createElement('div');
      head.textContent = `接続方法: ${r.via}`;
      box.appendChild(head);
      for (const x of r.results) {
        const line = document.createElement('div');
        const mark = document.createElement('span');
        mark.className = x.ok ? 'ok' : 'ng';
        mark.textContent = x.ok ? '✓ OK ' : '✕ 失敗 ';
        line.appendChild(mark);
        const detail = x.ok ? `(${x.ms}ms)` : (x.status === 407 ? '（プロキシの認証に失敗：ユーザー名・パスワードを確認）'
          : x.status ? `(HTTP ${x.status})` : `(${x.error})`);
        line.appendChild(document.createTextNode(`${x.url} ${detail}`));
        box.appendChild(line);
      }
      const allOk = r.results.every((x) => x.ok);
      toast(allOk ? '接続できました' : '接続できない宛先があります', allOk ? 'success' : 'error');
    } catch (e) {
      box.textContent = `接続テストに失敗しました: ${errorMessage(e)}`;
    } finally {
      btn.disabled = false;
    }
  }

  function renderSettingsPage() {
    const s = state.settings;
    renderProxy();
    $('#autosave-dir').textContent = s.autoSaveDir || '（自動保存しない）';
    $('#replace-text').value = s.replaceText || '';
  }

  function bindSettingsPage() {
    $$('input[name="proxyMode"]').forEach((r) => r.addEventListener('change', updateProxyFields));
    $('#btn-proxy-save').addEventListener('click', async () => {
      try {
        if (await saveProxy()) toast('プロキシ設定を保存しました', 'success');
      } catch (e) { toast(errorMessage(e), 'error'); }
    });
    $('#btn-proxy-test').addEventListener('click', testProxy);
    $('#btn-proxy-clearpass').addEventListener('click', async () => {
      await saveProxy({ clearPassword: true });
      toast('保存済みパスワードを削除しました');
    });
    $('#btn-autosave-choose').addEventListener('click', async () => {
      const dir = await api.chooseDir('自動保存するフォルダを選択');
      if (!dir) return;
      state.settings = await api.updateSettings({ autoSaveDir: dir });
      renderSettingsPage();
    });
    $('#btn-autosave-clear').addEventListener('click', async () => {
      state.settings = await api.updateSettings({ autoSaveDir: '' });
      renderSettingsPage();
    });
    $('#btn-autosave-open').addEventListener('click', async () => {
      if (!(await api.openFolder('autosave'))) toast('自動保存フォルダが設定されていません');
    });
    let t = null;
    $('#replace-text').addEventListener('input', (e) => {
      clearTimeout(t);
      const value = e.target.value;
      t = setTimeout(async () => {
        state.settings = await api.updateSettings({ replaceText: value });
      }, 500);
    });
  }

  /* ---------- 起動 ---------- */

  async function init() {
    state.info = await api.appInfo();
    state.settings = await api.getSettings();
    $('#app-version').textContent = `v${state.info.version}`;
    for (const n of state.info.notices || []) engineLog(n, 'success');

    if (state.info.platform === 'linux') {
      const note = $('#setup-platform-note');
      note.hidden = false;
      note.textContent = 'Linux でマイクを使うには PortAudio が必要です（例: sudo apt install libportaudio2）。';
    }

    const confirmClear = () => api.confirm('文字起こし結果をクリアしますか？',
      '「速報」「清書（高精度）」の両方の表示が消去されます。この操作は元に戻せません。\n（自動保存したファイルは消えません）', 'クリア');
    // 時刻の表示切り替えは両画面で共有し、設定に保存する（自動保存にも反映）
    const onShowTimeChange = async (on) => {
      liveView.setShowTime(on);
      fileView.setShowTime(on);
      state.settings = await api.updateSettings({ showTime: on });
    };
    liveView = new TranscriptView($('#live-transcript'), {
      onPartialDropped: (text) => engineLog(`聞き取り途中の文字が速報にならずに消えました（4 秒以上速報が届かない）: 「${text}」`, 'stderr'),
      onSave: (entries, format) => saveEntries(entries, format, 'リアルタイム'),
      onCopy: copyText,
      onNotify: (m) => toast(m),
      confirmClear,
      onShowTimeChange,
    }, { clockFallback: true });
    fileView = new TranscriptView($('#file-transcript'), {
      onSave: (entries, format) => saveEntries(entries, format, state.filePath || 'ファイル'),
      onCopy: copyText,
      onNotify: (m) => toast(m),
      confirmClear,
      onShowTimeChange,
    });
    lagChart = new RefineLagChart($('#lag-host'));
    // 結果をクリアしたらグラフも最初から
    const liveClear = liveView.clear.bind(liveView);
    liveView.clear = () => {
      liveClear();
      lagChart.reset();
      // 話者の番号（S1・S2…）も最初から振り直す（モデルを読み込んでいる間だけ）
      if (state.job === 'live' && state.engine !== 'idle' && state.engine !== 'loading') api.resetSpeakers().catch(() => {});
    };
    liveView.setShowTime(state.settings.showTime !== false);
    fileView.setShowTime(state.settings.showTime !== false);

    $$('.nav-item').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
    $$('[data-goto]').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.goto)));
    $('#btn-live').addEventListener('click', toggleLive);
    $('#btn-load').addEventListener('click', toggleLoad);
    $('#btn-reload').addEventListener('click', reloadLive);
    api.onReloadState(({ items }) => {
      $('#reload-banner').hidden = !items.length;
      $('#reload-text').textContent = items.length
        ? `「${items.join('」「')}」の変更は、モデルを読み込み直すと反映されます。` : '';
    });
    $('#btn-refresh-devices').addEventListener('click', loadDevices);
    $('#btn-clear-log').addEventListener('click', () => { $('#engine-log').textContent = ''; });

    // 外部リンクには、マウスを乗せたときに URL を表示する
    $$('a[href^="http"]').forEach((a) => { if (!a.title) a.title = a.getAttribute('href'); });
    populateProfiles();
    bindOptToggles();
    bindSetup();
    bindRunControls();
    bindEngine();
    bindFilePage();
    bindSettingsPage();

    const status = await api.setupStatus();
    state.status = status;
    renderSteps(status.steps);
    markStepsFromStatus(status);
    renderSetup();
    syncRunControls();
    renderSettingsPage();
    setEngine('idle', null);
    showPage(status.ready ? 'live' : 'setup');
    // 画面が再読み込みされた場合（処理は裏で続いている）は、実行中の状態に表示を合わせる
    const running = await api.engineState().catch(() => null);
    if (running && running.job === 'live') {
      setEngine(running.capturing ? 'capturing' : running.ready ? 'ready' : 'loading', 'live');
      showPage('live');
    } else if (running && running.job === 'file') {
      setEngine('running', 'file');
      showPage('file');
    }
  }

  init().catch((e) => toast(`初期化に失敗しました: ${errorMessage(e)}`, 'error', 10000));
})();
