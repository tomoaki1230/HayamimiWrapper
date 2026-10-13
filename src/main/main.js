'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, session, net, safeStorage, clipboard, Menu } = require('electron');
const { Settings } = require('./settings');
const { defaultRuntimeRoot, legacyRuntimeRoot, runtimePaths, resolveChosenRoot, hasNonAscii } = require('./paths');
const { LEGACY_NAME, migrateUserData, migrateRuntime } = require('./migrate');
const { Installer } = require('./installer');
const { Engine } = require('./engine');
const { buildHayamimiArgs, captureConfig, tuningEnv, runtimeConfig, reloadNeeded } = require('./args');
const { timeLabel } = require('../shared/timefmt');
const { convertToWav, MEDIA_EXTENSIONS } = require('./media');
const transcript = require('./transcript');
const { ProxyManager } = require('./proxy');
const { createElectronOpener } = require('./downloader');

/** @type {BrowserWindow|null} */
let win = null;
let settings;
let paths;
let installer;
let engine;
let fileJob = null; // { cancelled, child, wavPath }
let proxy;
let liveCapturing = false; // リアルタイムで音声を取り込み中か
let liveReady = false; // リアルタイムのモデルの読み込みが終わっているか（画面の再読み込み時に状態を戻すため）
const startupNotices = []; // 起動時の引き継ぎ処理などの記録（ログ画面に表示）
const autoSave = {}; // job → 自動保存ファイルのパス（清書が届くたびに時刻付きで追記）
let loadedRun = null; // リアルタイムのモデルを読み込んだときの設定（再読み込みが必要な変更の判定用）

/** リアルタイムのモデルを読み込んだまま、設定の変更を反映する（反映できないものは画面に知らせる） */
// 話者の記憶を消す合図（結果のクリア）。ラッパーは設定ファイルを 0.3 秒ごとに読むため、直後の別の書き込みで
// 合図が上書きされて読まれないことがないよう、モデルを読み込み直すまで以後の書き込みにも含め続ける（同じ値は一度だけ処理される）
let speakerResetNonce = null;

function liveConfig() {
  const s = settings.get();
  const cfg = runtimeConfig(s.run, s.replaceText);
  if (speakerResetNonce) cfg.reset_speakers = speakerResetNonce;
  return cfg;
}

function applyLiveSettings() {
  if (!engine || !engine.running || engine.job !== 'live') return;
  const s = settings.get();
  engine.applyConfig(liveConfig());
  send('engine:reload-state', { items: reloadNeeded(loadedRun, s.run) });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 実行環境のルートが変わったときに Installer / Engine を作り直す */
function initRuntime() {
  const root = settings.get().runtimeRoot || defaultRuntimeRoot(app);
  paths = runtimePaths(root);

  if (installer) installer.removeAllListeners();
  installer = new Installer(paths, {
    opener: createElectronOpener(net, () => proxy.credentials()),
    envProvider: () => proxy.childEnvDiff(),
    describeNetwork: () => proxy.describe(),
  });
  installer.on('progress', (p) => send('setup:progress', p));
  installer.on('log', (l) => send('setup:log', l));

  if (engine) engine.removeAllListeners();
  engine = new Engine(paths);
  engine.on('event', (event, job) => {
    if (event.type === 'refine') appendAutoSave(job, event);
    if (event.type === 'hm_capture_start') {
      liveCapturing = true;
      // 自動保存先は「開始」のたびに確認する（読み込み後にフォルダを変えた場合も反映）
      const dir = settings.get().autoSaveDir;
      if (job === 'live' && (!dir ? autoSave.live : !autoSave.live || path.dirname(autoSave.live) !== dir)) {
        autoSave.live = dir ? autoSavePath('live') : undefined;
      }
    }
    if (event.type === 'hm_config_applied' && event.errors && event.errors.length) {
      send('engine:log', { job, text: `一部の設定を反映できませんでした: ${event.errors.join(' / ')}`, level: 'error' });
    }
    if (['hm_paused', 'hm_ready', 'hm_capture_error'].includes(event.type)) liveCapturing = false;
    if (event.type === 'hm_ready' && job === 'live') liveReady = true;
    send('engine:event', { job, event });
  });
  engine.on('log', (log, job) => send('engine:log', { job, ...log }));
  engine.on('exit', (info) => {
    liveCapturing = false;
    if (info.job === 'live') liveReady = false;
    delete autoSave[info.job];
    if (info.job === 'live') {
      loadedRun = null;
      send('engine:reload-state', { items: [] });
    }
    if (info.job === 'file' && fileJob) {
      if (fileJob.wavPath) fs.rmSync(fileJob.wavPath, { force: true });
      fileJob = null;
    }
    send('engine:exit', info);
  });
}

function createWindow() {
  // インストール版では Electron の標準メニューを外す（Ctrl+R の再読み込みで、文字起こし中なのに画面だけが初期化されるのを防ぐ。
  // 開発者ツールも開けなくなる）。Windows では、メニューが無くても入力欄のコピー・貼り付けは使える
  if (app.isPackaged) Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 920,
    minHeight: 620,
    title: 'HayamimiWrapper',
    backgroundColor: '#f6f4ef',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 外部リンクは既定のブラウザで開き、アプリ内では遷移させない
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

/** 画面へ渡す設定（パスワードは渡さず、有無だけ伝える） */
function publicSettings() {
  const s = settings.get();
  const { passwordEnc, ...rest } = s.proxy || {};
  s.proxy = { ...rest, hasPassword: !!passwordEnc, passwordEncrypted: String(passwordEnc || '').startsWith('enc:') };
  return s;
}

/** 画面からのプロキシ設定変更を保存形式にする（password は暗号化、未指定なら現状維持） */
function mergeProxy(patch) {
  const current = settings.get().proxy || {};
  const next = { ...current };
  for (const key of ['mode', 'url', 'bypass', 'username']) {
    if (typeof patch[key] === 'string') next[key] = patch[key].trim();
  }
  if (!['system', 'manual', 'none'].includes(next.mode)) next.mode = 'system';
  if (typeof patch.password === 'string') next.passwordEnc = proxy.encryptPassword(patch.password);
  if (patch.clearPassword) next.passwordEnc = '';
  return next;
}

/** 置換辞書をファイルへ書き出し、パスを返す（空なら null） */
function prepareReplaceFile() {
  const text = (settings.get().replaceText || '').trim();
  if (!text) return null;
  fs.mkdirSync(path.dirname(paths.replaceFile), { recursive: true });
  fs.writeFileSync(paths.replaceFile, `${text}\n`, 'utf8');
  return paths.replaceFile;
}

const autoSaveFailing = {}; // job → 追記に失敗し続けているか（ログを繰り返し出さないため）

/** 清書イベントを自動保存ファイルへ追記する（時刻は設定に従う） */
function appendAutoSave(job, event) {
  const file = autoSave[job];
  if (!file || !event.text) return;
  const time = settings.get().showTime ? timeLabel({ t: event.t, startS: event.start_s }) : '';
  const line = transcript.toLine({ text: event.text, speaker: event.speaker, time });
  try {
    try {
      fs.appendFileSync(file, line, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // 文字起こし中に保存先フォルダが消えた（移動・削除・USB メモリを抜いた等）→ 作り直して続ける
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line, 'utf8');
    }
    if (autoSaveFailing[job]) {
      autoSaveFailing[job] = false;
      send('engine:log', { job, text: `自動保存を再開しました: ${file}`, level: 'success' });
    }
  } catch (e) {
    if (!autoSaveFailing[job]) {
      autoSaveFailing[job] = true;
      send('engine:log', { job, text: `自動保存に失敗しました（文字起こしは続けます）: ${e.message}`, level: 'error' });
      send('engine:event', { job, event: { type: 'warning', code: 'autosave_failed', message: `自動保存に失敗しました: ${e.message}` } });
    }
  }
}

/** 自動保存ファイルのパス。保存先を作れない場合は自動保存を行わず（null）、文字起こしは続ける */
function autoSavePath(prefix, job = 'live') {
  const dir = settings.get().autoSaveDir;
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    send('engine:log', { job, text: `自動保存先のフォルダを作れないため、自動保存を行いません: ${e.message}`, level: 'error' });
    send('engine:event', { job, event: { type: 'warning', code: 'autosave_dir', message: `自動保存先のフォルダを作れません（${e.code || e.message}）。「設定」で保存先を確認してください` } });
    return null;
  }
  autoSaveFailing[job] = false;
  return path.join(dir, `${prefix}-${transcript.fileStamp()}.txt`);
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    version: app.getVersion(),
    defaultRoot: defaultRuntimeRoot(app),
    mediaExtensions: MEDIA_EXTENSIONS,
    notices: startupNotices,
  }));

  ipcMain.handle('settings:get', () => publicSettings());
  // 実行中の処理の状態（画面が再読み込みされたときに表示を合わせるため）
  ipcMain.handle('engine:state', () => ({
    job: fileJob ? 'file' : (engine && engine.running ? engine.job : null),
    capturing: liveCapturing,
    ready: liveReady,
  }));
  ipcMain.handle('settings:update', async (_e, patch) => {
    // runtimeRoot の変更はセットアップ画面の専用操作でのみ受け付ける
    const { runtimeRoot, proxy: proxyPatch, ...rest } = patch || {};
    if (proxyPatch) rest.proxy = mergeProxy(proxyPatch);
    settings.update(rest);
    if (proxyPatch) await proxy.apply();
    if (rest.run || rest.replaceText !== undefined) applyLiveSettings();
    return publicSettings();
  });

  ipcMain.handle('proxy:test', async () => {
    await proxy.apply();
    const open = createElectronOpener(net, () => proxy.credentials());
    return proxy.test((url) => open(url));
  });

  ipcMain.handle('setup:status', () => ({
    ...installer.getStatus(),
    // Windows で保存場所に日本語などを含む場合は、モデルを読み込めない可能性があるので警告する
    rootWarning: process.platform === 'win32' && hasNonAscii(paths.root),
  }));
  ipcMain.handle('setup:install', async (_e, opts) => {
    // 動いている hayamimi の Python 環境・モデルを入れ直すと、Windows では使用中のファイルを上書きできず失敗・破損しうる
    if (engine.running || fileJob) {
      throw new Error('モデルを読み込んでいる間（または文字起こし中）は、モデルの切り替え・修復はできません。「リアルタイム」画面の「モデルを解放」を押してから実行してください。');
    }
    const modelSet = opts && opts.modelSet === 'full' ? 'full' : 'minimal';
    settings.update({ modelSet });
    return installer.install({ modelSet });
  });
  ipcMain.handle('setup:cancel', () => installer.cancel());
  ipcMain.handle('setup:sizes', () => installer.stepSizes());
  // 各手順で導入したものを元に戻す（実行中の文字起こしがあれば先に止める必要がある）
  ipcMain.handle('setup:undo', async (_e, stepId) => {
    if (engine.running || fileJob) throw new Error('文字起こし中（またはモデル読み込み中）は元に戻せません。先に停止・解放してください。');
    return stepId === 'all' ? installer.undoAll() : installer.undoStep(stepId);
  });
  ipcMain.handle('setup:chooseRoot', async () => {
    if (installer.running || engine.running) {
      throw new Error('実行中は保存場所を変更できません');
    }
    const r = await dialog.showOpenDialog(win, {
      title: 'hayamimi とモデルの保存場所を選択',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return installer.getStatus();
    // 既存のファイルがあるフォルダを選んだ場合は、その中に専用フォルダを作る（既存のものを上書きしない）
    settings.update({ runtimeRoot: resolveChosenRoot(r.filePaths[0]) });
    initRuntime();
    return installer.getStatus();
  });
  ipcMain.handle('setup:resetRoot', () => {
    if (installer.running || engine.running) throw new Error('実行中は保存場所を変更できません');
    settings.update({ runtimeRoot: '' });
    initRuntime();
    return installer.getStatus();
  });

  ipcMain.handle('engine:devices', () => engine.listDevices());

  // リアルタイム: モデルを読み込み、音声入力は開かずに待機させる
  ipcMain.handle('engine:loadLive', (_e, runOptions) => {
    if (fileJob || engine.running) throw new Error('すでに実行中です');
    settings.update({ run: runOptions });
    speakerResetNonce = null; // 新しいプロセスでは話者の記憶は空なので、前回のクリアの合図は不要
    const transcriptPath = autoSavePath('live');
    const args = buildHayamimiArgs(runOptions, { replacePath: prepareReplaceFile(), liveGate: true });
    engine.start(args, 'live', { gate: true, env: tuningEnv(runOptions) });
    autoSave.live = transcriptPath;
    loadedRun = JSON.parse(JSON.stringify(runOptions));
    send('engine:reload-state', { items: [] });
    return { transcriptPath };
  });

  // リアルタイム: 音声の取り込みを開始・入力切り替え（runOptions）／停止（false）。モデルは読み込んだまま
  ipcMain.handle('engine:capture', (_e, runOptions) => {
    if (!engine.running || engine.job !== 'live') throw new Error('モデルが読み込まれていません');
    if (!runOptions) return engine.setCapture(null);
    const { micOn, loopbackOn, micDevice, speakerDevice } = runOptions;
    settings.update({ run: { micOn, loopbackOn, micDevice, speakerDevice } });
    const config = captureConfig(runOptions);
    engine.setCapture(config);
    return config;
  });

  // 結果のクリア: 話者の記憶も消して S1 から振り直す（読み込み中のリアルタイムのみ。設定ファイル経由でラッパーへ）
  ipcMain.handle('engine:resetSpeakers', () => {
    if (!engine || !engine.running || engine.job !== 'live') return false;
    speakerResetNonce = Date.now();
    return engine.applyConfig(liveConfig());
  });

  // クリップボードへの書き込み（画面側の navigator.clipboard はウインドウにフォーカスが無いと失敗するため、メインで行う）
  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('dialog:confirm', async (_e, { message, detail, ok }) => {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [ok || 'OK', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: String(message || ''),
      detail: detail ? String(detail) : undefined,
      noLink: true,
    });
    return r.response === 0;
  });

  ipcMain.handle('engine:startFile', async (_e, { filePath, runOptions }) => {
    if (fileJob) throw new Error('すでに文字起こしを実行中です');
    if (engine.running && engine.job === 'live') {
      if (liveCapturing) throw new Error('リアルタイム文字起こし中です。停止してから実行してください。');
      // 待機中のリアルタイム用モデルを解放してからファイル処理を始める
      send('engine:log', { job: 'live', text: 'ファイル文字起こしのため、リアルタイム用のモデルを解放します', level: 'info' });
      await engine.stopAndWait();
    }
    if (engine.running) throw new Error('すでに文字起こしを実行中です');
    engine.checkReady();
    fileJob = { cancelled: false, child: null, wavPath: null };
    const job = fileJob;
    try {
      send('file:progress', { phase: 'convert', fraction: 0 });
      const { wavPath, duration } = await convertToWav(filePath, paths.workDir,
        (fraction) => send('file:progress', { phase: 'convert', fraction }),
        (child) => { job.child = child; });
      job.wavPath = wavPath;
      job.child = null;
      if (job.cancelled) throw new Error('キャンセルされました');
      const base = path.parse(filePath).name.replace(/[\\/:*?"<>|]/g, '_');
      const transcriptPath = autoSavePath(base, 'file');
      const args = buildHayamimiArgs(runOptions, { wavPath, replacePath: prepareReplaceFile() });
      send('file:progress', { phase: 'transcribe', duration });
      engine.start(args, 'file', { env: tuningEnv(runOptions) });
      autoSave.file = transcriptPath;
      return { transcriptPath, duration };
    } catch (err) {
      if (job.wavPath) fs.rmSync(job.wavPath, { force: true });
      fileJob = null;
      if (err.tail) send('engine:log', { job: 'file', text: `ffmpeg の出力:\n${err.tail}`, level: 'stderr' });
      throw err;
    }
  });

  ipcMain.handle('engine:stop', () => {
    if (fileJob && fileJob.child) {
      fileJob.cancelled = true;
      fileJob.child.kill();
      return true;
    }
    return engine.stop();
  });

  ipcMain.handle('file:choose', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: '文字起こしする音声・動画ファイルを選択',
      properties: ['openFile'],
      filters: [
        { name: '音声・動画ファイル', extensions: MEDIA_EXTENSIONS },
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:chooseDir', async (_e, title) => {
    const r = await dialog.showOpenDialog(win, {
      title: title || 'フォルダを選択',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('transcript:save', async (_e, { entries, format, meta }) => {
    const kind = ['txt', 'md', 'json'].includes(format) ? format : 'txt';
    const r = await dialog.showSaveDialog(win, {
      title: '文字起こし結果を保存',
      defaultPath: `hayamimi-${transcript.fileStamp()}.${kind}`,
      filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
    });
    if (r.canceled || !r.filePath) return null;
    const body = transcript.format(entries, kind, { ...(meta || {}), date: new Date() });
    fs.writeFileSync(r.filePath, body, 'utf8');
    return r.filePath;
  });

  ipcMain.handle('shell:open', (_e, target) => {
    const dir = target === 'autosave' ? settings.get().autoSaveDir : paths.root;
    if (!dir) return false;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return true;
  });

}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// Windows のタスクバー・通知でアプリを正しく識別させる
if (process.platform === 'win32') app.setAppUserModelId('com.tomoaki.hayamimiwrapper');

/** 旧名称（Hayamimi3）の設定・実行環境を引き継ぐ */
function migrateFromLegacy() {
  const note = (m) => { startupNotices.push(m); console.log(m); };
  try {
    if (migrateUserData(path.join(app.getPath('appData'), LEGACY_NAME), app.getPath('userData'))) {
      note('旧バージョン（Hayamimi3）の設定を引き継ぎました。');
    }
  } catch (e) {
    note(`旧バージョンの設定を引き継げませんでした: ${e.message}`);
  }
}

function migrateLegacyRuntime() {
  if (settings.get().runtimeRoot) return; // 保存場所を自分で指定している場合はそのまま
  const result = migrateRuntime(legacyRuntimeRoot(app, LEGACY_NAME), defaultRuntimeRoot(app),
    (m) => { startupNotices.push(m); console.log(m); });
  if (result === 'kept-legacy') settings.update({ runtimeRoot: legacyRuntimeRoot(app, LEGACY_NAME) });
}

app.whenReady().then(async () => {
  migrateFromLegacy();
  settings = new Settings(app);
  migrateLegacyRuntime();
  proxy = new ProxyManager({
    getProxy: () => settings.get().proxy,
    session: session.defaultSession,
    safeStorage,
  });
  try {
    await proxy.apply();
  } catch (e) {
    console.error('プロキシ設定の反映に失敗しました:', e);
  }
  // 画面（webContents）側でプロキシ認証を求められた場合も、設定の認証情報で応答する
  app.on('login', (event, _wc, _details, authInfo, callback) => {
    const creds = authInfo.isProxy ? proxy.credentials() : null;
    if (creds) {
      event.preventDefault();
      callback(creds.username, creds.password);
    }
  });
  initRuntime();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (installer && installer.running) installer.cancel();
  if (fileJob && fileJob.child) fileJob.child.kill();
  // 文字起こし中に閉じた場合も、残りの速報・清書（と自動保存）を終えてから終了する（最大 15 秒）
  if (engine && engine.running && !quitting) {
    e.preventDefault();
    quitting = true;
    engine.stopAndWait(15000).finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
