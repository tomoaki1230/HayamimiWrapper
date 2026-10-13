'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { LineSplitter, parseLine } = require('./lineParser');
const { isolatedEnv } = require('./env');

/**
 * hayamimi（realtime_transcribe.py）をラッパー経由で起動・停止し、
 * 構造化イベントとログを EventEmitter で通知する。
 *
 * リアルタイム（gate: true）では、モデル読み込み後に音声入力を開かず待機させ、
 * setCapture(true/false) で取り込みの開始・停止を切り替える（モデルは読み込んだまま）。
 *
 * events:
 *   'event' (event: object, job: string)  hayamimi のイベント（partial/final/refine/...）
 *   'log'   ({text, level}, job)          通常ログ
 *   'exit'  ({code, signal, job, stopped})
 */

const RUNNER_SOURCE = path.join(__dirname, '..', 'python', 'hayamimi_runner.py');

function pythonEnv() {
  // ユーザーの別の Python 環境の設定（PYTHONPATH 等）を持ち込まない
  return isolatedEnv(process.env);
}

class Engine extends EventEmitter {
  /** @param {ReturnType<import('./paths').runtimePaths>} paths */
  constructor(paths) {
    super();
    this.p = paths;
    this.child = null;
    this.job = null;
    this.stopRequested = false;
  }

  get running() {
    return !!this.child;
  }

  /** ラッパースクリプトを実ファイルとして配置する（asar 内からは Python が読めないため） */
  ensureRunner() {
    fs.mkdirSync(path.dirname(this.p.runnerScript), { recursive: true });
    fs.writeFileSync(this.p.runnerScript, fs.readFileSync(RUNNER_SOURCE));
    return this.p.runnerScript;
  }

  checkReady() {
    if (!fs.existsSync(this.p.venvPython) || !fs.existsSync(this.p.transcribeScript)) {
      throw new Error('hayamimi がまだセットアップされていません。「セットアップ」画面から導入してください。');
    }
  }

  /**
   * 文字起こしを開始する。
   * @param {string[]} args realtime_transcribe.py への引数
   * @param {string} job ジョブ種別（'live' | 'file'）
   * @param {object} [opts]
   * @param {boolean} [opts.gate] 読み込み後に待機させ、setCapture で取り込みを制御する
   * @param {object} [opts.env] 追加の環境変数（プロファイルの HM_VAD_THRESHOLD 等）
   */
  start(args, job, opts = {}) {
    if (this.child) throw new Error('すでに文字起こしを実行中です。先に停止してください。');
    this.checkReady();
    const runner = this.ensureRunner();
    this.job = job;
    this.stopRequested = false;

    // 停止はファイルで伝える（標準入力は使わない。理由は hayamimi_runner.py の冒頭を参照）
    fs.mkdirSync(this.p.workDir, { recursive: true });
    const base = path.join(this.p.workDir, `ctl-${process.pid}-${Date.now()}`);
    const stopFile = `${base}.stop`;
    const gateFile = opts.gate ? `${base}.go` : '';
    const configFile = `${base}.cfg`; // 実行中に変える設定（ラッパーが監視して反映する）
    fs.rmSync(configFile, { force: true });
    this.configFile = configFile;
    fs.rmSync(stopFile, { force: true });
    if (gateFile) fs.rmSync(gateFile, { force: true });
    this.stopFile = stopFile;
    this.gateFile = gateFile;

    const child = spawn(this.p.venvPython, ['-u', runner, this.p.hayamimiDir, '--', ...args], {
      cwd: this.p.hayamimiDir,
      env: {
        ...pythonEnv(),
        HM_STOP_FILE: stopFile,
        HM_PARENT_PID: String(process.pid),
        ...(gateFile ? { HM_GATE_FILE: gateFile } : {}),
        HM_CONFIG_FILE: configFile,
        ...(opts.env || {}),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const envNote = Object.entries(opts.env || {}).map(([k, v]) => `${k}=${v}`).join(' ');
    this.emit('log', { text: `> ${envNote ? `${envNote} ` : ''}hayamimi ${args.join(' ')}`, level: 'cmd' }, job);
    // 認識・清書は CPU を多く使うため優先度を「通常以下」にし、画面の描画が待たされないようにする
    // （CPU が空いていれば速度は変わらない）
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (e) {
      this.emit('log', { text: `優先度を変更できませんでした: ${e.message}`, level: 'stderr' }, job);
    }

    const handle = (line, stream) => {
      const parsed = parseLine(line);
      if (!parsed) return;
      if (parsed.kind === 'event') this.emit('event', parsed.event, job);
      // source: 'engine' = hayamimi の出力（画面のログで、アプリのメッセージと色分けする）
      else this.emit('log', { text: parsed.text, level: stream === 'stderr' ? 'stderr' : 'info', source: 'engine' }, job);
    };
    const out = new LineSplitter((l) => handle(l, 'stdout'));
    const err = new LineSplitter((l) => handle(l, 'stderr'));
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));

    child.on('error', (e) => {
      this.emit('log', { text: `起動に失敗しました: ${e.message}`, level: 'error' }, job);
    });
    child.on('close', (code, signal) => {
      out.flush();
      err.flush();
      clearTimeout(this.killTimer);
      fs.rmSync(stopFile, { force: true });
      if (gateFile) fs.rmSync(gateFile, { force: true });
      fs.rmSync(configFile, { force: true });
      this.gateFile = '';
      const stopped = this.stopRequested;
      this.child = null;
      this.job = null;
      this.emit('exit', { code, signal, job, stopped });
    });
  }

  /**
   * 音声の取り込みを開始・切り替え（config）／停止（null）する。gate 付きで起動したときのみ有効。
   * config: { source: 'mic' | 'speaker' | 'mix', micDevice, speakerDevice }
   * 取り込み中に内容を変えると、ラッパーが入力を開き直す（モデルは読み込んだまま）。
   */
  setCapture(config) {
    if (!this.child || !this.gateFile) throw new Error('モデルが読み込まれていません');
    if (config) fs.writeFileSync(this.gateFile, JSON.stringify(config));
    // Windows では Python が読み込んでいる一瞬は削除できない（共有違反）ため、再試行する
    else fs.rmSync(this.gateFile, { force: true, recursive: true, maxRetries: 10, retryDelay: 30 });
    return true;
  }

  /**
   * モデルを読み込んだまま設定を反映する（ラッパーが設定ファイルを監視している）。
   * @param {object} config hayamimi_runner.py の _apply_config が受け付ける形
   */
  applyConfig(config) {
    if (!this.child || !this.configFile) return false;
    fs.writeFileSync(this.configFile, JSON.stringify(config));
    return true;
  }

  /** 停止を依頼し、プロセスの終了まで待つ */
  stopAndWait(timeoutMs = 20000) {
    if (!this.child) return Promise.resolve();
    return new Promise((resolve) => {
      this.once('exit', () => resolve());
      this.stop(timeoutMs);
    });
  }

  /** 正常終了を依頼し、一定時間で終わらなければ強制終了する */
  stop(timeoutMs = 20000) {
    if (!this.child) return false;
    this.stopRequested = true;
    try {
      fs.writeFileSync(this.stopFile, 'stop');
    } catch (e) {
      this.emit('log', { text: `停止ファイルを作成できませんでした: ${e.message}`, level: 'error' }, this.job);
    }
    clearTimeout(this.killTimer);
    const child = this.child;
    this.killTimer = setTimeout(() => {
      if (!child.killed) child.kill();
    }, timeoutMs);
    return true;
  }

  /** マイク・スピーカー一覧を取得する */
  listDevices() {
    this.checkReady();
    const runner = this.ensureRunner();
    return new Promise((resolve, reject) => {
      const child = spawn(this.p.venvPython, ['-u', runner, this.p.hayamimiDir, '--devices'], {
        cwd: this.p.hayamimiDir,
        env: pythonEnv(),
        windowsHide: true,
      });
      let result = null;
      let errText = '';
      const out = new LineSplitter((l) => {
        const parsed = parseLine(l);
        if (parsed && parsed.kind === 'event' && parsed.event.type === 'hm_devices') result = parsed.event;
      });
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => { errText += d.toString('utf8'); });
      child.on('error', reject);
      child.on('close', () => {
        out.flush();
        if (result) resolve(result);
        else reject(new Error(`デバイス一覧を取得できませんでした。${errText.trim().split('\n').pop() || ''}`));
      });
    });
  }
}

module.exports = { Engine };
