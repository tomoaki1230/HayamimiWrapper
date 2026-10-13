'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { download, extract, findFile } = require('./downloader');
const { run } = require('./proc');
const { parsePercent } = require('./lineParser');
const { applyEnv } = require('./proxy');
const { isolatedEnv, uvIsolation } = require('./env');

// この保存場所をアプリが作成・管理していることを示す印。印のない場所の hayamimi は上書きしない
const ROOT_MARKER = '.hayamimiwrapper-root';
// インストールしない依存（韓国語の分かち書き補正用。hayamimi は無くても動作する）
const EXCLUDED_PACKAGES = ['kiwipiepy', 'kiwipiepy-model'];

/**
 * hayamimi の自動セットアップ。
 * 事前に Python や git を入れていなくても動くよう、uv（単体バイナリ）で Python ごと用意する。
 *
 * 手順: uv取得 → hayamimi取得 → Python環境作成 → 依存ライブラリ → モデル
 *
 * 上流の更新で動かなくなるのを防ぐため、hayamimi・uv・Python は動作確認済みのバージョンに固定する。
 * 自動で最新版を取りに行くことはしない。固定バージョンを上げるときはここを変更し、動作確認すること。
 */

const PINNED = Object.freeze({
  // hayamimi main @ 2026-09-16（HayamimiWrapper で動作確認済み）
  hayamimiCommit: '09c8081420c7c88374eb24ae533ea470de794203',
  uvVersion: '0.13.0',
  // hayamimi の requirements.txt が検証済みの 3.11 系
  pythonVersion: '3.11.17',
});

const HAYAMIMI_TARBALL = `https://codeload.github.com/oboroge0/hayamimi/tar.gz/${PINNED.hayamimiCommit}`;
const SOURCE_STAMP = '.hayamimiwrapper-source.json'; // hayamimi フォルダ内に置く取得バージョン記録
const LEGACY_SOURCE_STAMP = '.hayamimi3-source.json'; // 旧名称時代の記録（読み取りのみ）

const STEPS = [
  { id: 'uv', label: 'セットアップ用ツール（uv）の準備', weight: 5 },
  { id: 'source', label: 'hayamimi 本体のダウンロード', weight: 5 },
  { id: 'python', label: 'Python 環境の作成', weight: 15 },
  { id: 'deps', label: '必要なライブラリのインストール', weight: 25 },
  { id: 'models', label: '音声認識モデルのダウンロード', weight: 50 },
];

function uvAssetName() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  switch (process.platform) {
    case 'win32':
      return `uv-${arch}-pc-windows-msvc.zip`;
    case 'darwin':
      return `uv-${arch}-apple-darwin.tar.gz`;
    default:
      return `uv-${arch}-unknown-linux-gnu.tar.gz`;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** requirements.txt から指定パッケージの行を除く（コメント・環境マーカー付きの行にも対応） */
function filterRequirements(text, excluded) {
  const names = excluded.map((n) => n.toLowerCase().replace(/[-_.]+/g, '-'));
  return String(text).split(/\r?\n/).filter((line) => {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
    if (!m) return true;
    return !names.includes(m[1].toLowerCase().replace(/[-_.]+/g, '-'));
  }).join('\n');
}

function formatBytes(n) {
  if (!n) return '0B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)}${units[i]}`;
}

class Installer extends EventEmitter {
  /**
   * @param {ReturnType<import('./paths').runtimePaths>} paths
   * @param {object} [deps]
   * @param {Function} [deps.opener] ダウンロードの接続方法（Electron ではプロキシ対応の net）
   * @param {() => Promise<object>} [deps.envProvider] 子プロセスへ渡す環境変数の差分（プロキシ）
   * @param {() => Promise<string>} [deps.describeNetwork] ログ用の接続方法の説明
   */
  constructor(paths, deps = {}) {
    super();
    this.p = paths;
    this.opener = deps.opener;
    this.envProvider = deps.envProvider;
    this.describeNetwork = deps.describeNetwork;
    this.netEnv = {};
    this.running = false;
    this.child = null;
    this.abort = null;
    this.cancelled = false;
  }

  /** インストール状況を返す */
  /** venv の site-packages フォルダ（無ければ null） */
  sitePackagesDir() {
    const v = this.p.venvDir;
    const win = path.join(v, 'Lib', 'site-packages');
    if (fs.existsSync(win)) return win;
    try {
      const lib = path.join(v, 'lib');
      const py = fs.readdirSync(lib).find((n) => n.startsWith('python'));
      if (py) return path.join(lib, py, 'site-packages');
    } catch {
      // venv が無い
    }
    return null;
  }

  /** 各手順で入れたものが残っているか（「元に戻す」ボタンの表示用） */
  presentSteps() {
    const p = this.p;
    const sp = this.sitePackagesDir();
    const nonEmpty = (d) => { try { return fs.readdirSync(d).length > 0; } catch { return false; } };
    return {
      uv: fs.existsSync(p.uvExe) || fs.existsSync(p.uvCacheDir),
      source: fs.existsSync(p.transcribeScript),
      python: fs.existsSync(p.venvDir) || nonEmpty(p.pythonInstallDir),
      deps: !!sp && fs.existsSync(path.join(sp, 'sherpa_onnx')),
      models: nonEmpty(p.modelsDir),
    };
  }

  getStatus() {
    const p = this.p;
    const marker = readJson(p.marker);
    const sourceCommit = this.sourceCommit();
    const present = this.presentSteps();
    const source = present.source && sourceCommit === PINNED.hayamimiCommit;
    const python = fs.existsSync(p.venvPython);
    const models = !!marker && present.models;
    return {
      present,
      deps: present.deps,
      root: p.root,
      uv: fs.existsSync(p.uvExe),
      source,
      python,
      models,
      modelSet: marker ? marker.modelSet : null,
      installedAt: marker ? marker.installedAt : null,
      sourceCommit,
      pinned: PINNED,
      ready: source && python && present.deps && models,
      running: this.running,
      steps: STEPS.map(({ id, label }) => ({ id, label })),
    };
  }

  /** 取得済み hayamimi のコミット（記録がなければ null） */
  sourceCommit() {
    const stamp = readJson(path.join(this.p.hayamimiDir, SOURCE_STAMP))
      || readJson(path.join(this.p.hayamimiDir, LEGACY_SOURCE_STAMP));
    return stamp ? stamp.commit : null;
  }

  /** コマンドの出力（標準出力＋標準エラー）を文字列で得る。失敗時は null */
  async output(cmd, args, env) {
    let text = '';
    try {
      await run(cmd, args, { env, onLine: (l) => { text += `${l}\n`; } });
      return text.trim();
    } catch {
      return null;
    }
  }

  /** プロキシ設定を反映した環境変数 */
  baseEnv() {
    return applyEnv(isolatedEnv(process.env), this.netEnv);
  }

  uvEnv() {
    return {
      ...this.baseEnv(),
      ...uvIsolation({ pythonInstallDir: this.p.pythonInstallDir, cacheDir: this.p.uvCacheDir }),
    };
  }

  /** この保存場所をアプリが管理しているか（印、または過去にアプリが導入した記録がある） */
  ownsRoot() {
    const p = this.p;
    return fs.existsSync(path.join(p.root, ROOT_MARKER)) || fs.existsSync(p.marker) || this.sourceCommit() !== null;
  }

  /**
   * 既存の環境を壊さないための確認。アプリが作っていない hayamimi フォルダがある場所では中止する。
   * 問題なければ印を書き込む。
   */
  guardRoot() {
    const p = this.p;
    if (!this.ownsRoot() && fs.existsSync(p.hayamimiDir) && fs.readdirSync(p.hayamimiDir).length > 0) {
      throw new Error(`保存場所に、このアプリが作成していない hayamimi フォルダがあります（${p.hayamimiDir}）。`
        + '既存の環境を上書きしないよう中止しました。「セットアップ」画面で別の保存場所を選んでください。');
    }
    try {
      fs.mkdirSync(p.root, { recursive: true });
    } catch (e) {
      throw new Error(`保存場所を作成できませんでした（${p.root}）: ${e.message}。「セットアップ」画面の「変更…」で書き込みできるフォルダを選んでください。`);
    }
    const marker = path.join(p.root, ROOT_MARKER);
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, 'このフォルダは HayamimiWrapper が管理しています。削除するとアプリの実行環境（モデルを含む）が消えます。\n');
    }
  }

  log(text, level = 'info') {
    this.emit('log', { text, level });
  }

  progress(stepId, status, extra = {}) {
    this.emit('progress', { step: stepId, status, ...extra });
  }

  cancel() {
    this.cancelled = true;
    if (this.abort) this.abort.abort();
    if (this.child && !this.child.killed) this.child.kill();
  }

  /** 子プロセス実行（ログ転送・キャンセル対応） */
  exec(cmd, args, opts = {}) {
    const { onLine, ...rest } = opts;
    this.log(`> ${path.basename(cmd)} ${args.join(' ')}`, 'cmd');
    return run(cmd, args, {
      ...rest,
      onSpawn: (c) => { this.child = c; },
      onLine: (line, stream) => {
        if (onLine) onLine(line, stream);
        if (line.trim()) this.log(line, stream === 'stderr' ? 'stderr' : 'info');
      },
    }).finally(() => { this.child = null; });
  }

  async canRun(cmd, args) {
    try {
      await run(cmd, args, {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * セットアップを実行する。
   * @param {object} opts
   * @param {'minimal'|'full'} opts.modelSet
   */
  async install(opts = {}) {
    if (this.running) throw new Error('セットアップはすでに実行中です');
    this.running = true;
    this.cancelled = false;
    const modelSet = opts.modelSet === 'full' ? 'full' : 'minimal';
    let done = 0;
    const total = STEPS.reduce((s, x) => s + x.weight, 0);
    const overall = (step, frac) => Math.round(((done + step.weight * frac) / total) * 100);

    try {
      this.guardRoot();
      this.netEnv = this.envProvider ? await this.envProvider() : {};
      if (this.describeNetwork) this.log(`接続方法: ${await this.describeNetwork()}`);
      for (const step of STEPS) {
        if (this.cancelled) throw new Error('キャンセルされました');
        this.progress(step.id, 'running', { overall: overall(step, 0) });
        // stepOnly: ファイル単位の進捗など、全体バーへ反映しない値
        const report = (frac, message, stepOnly = false) => this.progress(step.id, 'running', {
          percent: Math.round(frac * 100), message, overall: overall(step, stepOnly ? 0 : frac),
        });
        const skipped = await this[`step_${step.id}`]({ modelSet, report });
        done += step.weight;
        this.progress(step.id, skipped ? 'skipped' : 'done', { overall: overall(step, 0) });
      }
      fs.writeFileSync(this.p.marker, JSON.stringify({
        modelSet,
        installedAt: new Date().toISOString(),
        hayamimiCommit: PINNED.hayamimiCommit,
        uv: PINNED.uvVersion,
        python: PINNED.pythonVersion,
      }, null, 2));
      this.log('セットアップが完了しました。', 'success');
    } catch (err) {
      if (err.tail) this.log(err.tail, 'stderr');
      this.log(`エラー: ${err.message}`, 'error');
      throw err;
    } finally {
      this.running = false;
      this.abort = null;
    }
    return this.getStatus();
  }

  /* ---------- 元に戻す ---------- */

  /** 保存場所の中のパスであることを確かめてから削除する（保存場所の外は絶対に消さない） */
  removeInRoot(target) {
    const rel = path.relative(this.p.root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`保存場所の外は削除できません: ${target}`);
    }
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      this.log(`削除しました: ${target}`);
    }
  }

  /** 元に戻す前の共通チェック */
  checkUndoAllowed() {
    if (this.running) throw new Error('セットアップの実行中は元に戻せません');
    if (!this.ownsRoot()) {
      throw new Error('この保存場所はアプリが作成したものではないため、削除しません');
    }
  }

  /** 導入完了の記録を消す（再セットアップが必要な状態にする） */
  clearMarker() {
    if (fs.existsSync(this.p.marker)) fs.rmSync(this.p.marker, { force: true });
  }

  /**
   * 各手順で使っている容量（バイト）。
   * uv はライブラリをキャッシュからハードリンクで入れるため、同じ実体（inode）は一度だけ数える。
   * ライブラリ・Python・本体・モデルを先に数え、uv には uv のキャッシュだけが持つ容量を表示する。
   */
  async stepSizes() {
    const p = this.p;
    const makeDu = () => {
      const seen = new Set();
      const du = async (target, skip = () => false) => {
        let total = 0;
        const add = (st) => {
          const key = `${st.dev}:${st.ino}`;
          if (st.ino && seen.has(key)) return;
          if (st.ino) seen.add(key);
          total += st.size;
        };
        const walk = async (d) => {
          let ents;
          try {
            ents = await fs.promises.readdir(d, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of ents) {
            const q = path.join(d, e.name);
            if (e.isSymbolicLink() || skip(q)) continue;
            if (e.isDirectory()) await walk(q);
            else {
              try { add(await fs.promises.stat(q)); } catch { /* 無視 */ }
            }
          }
        };
        try {
          const st = await fs.promises.lstat(target);
          if (st.isDirectory()) await walk(target);
          else if (st.isFile()) add(st);
        } catch {
          // 存在しない
        }
        return total;
      };
      return du;
    };
    const du = makeDu();
    const sp = this.sitePackagesDir();
    const deps = sp ? await du(sp) : 0;
    const python = (await du(p.venvDir, (q) => q === sp)) + (await du(p.pythonInstallDir));
    const sourceSkip = (q) => q === p.venvDir || q === p.modelsDir;
    const source = await du(p.hayamimiDir, sourceSkip);
    const models = await du(p.modelsDir);
    const uv = (await du(p.uvDir)) + (await du(p.uvCacheDir));
    const all = await makeDu()(p.root);
    return { uv, source, python, deps, models, all };
  }

  /**
   * 指定した手順で導入したものを元に戻す（削除・アンインストール）。
   * @param {'uv'|'source'|'python'|'deps'|'models'} id
   */
  async undoStep(id) {
    this.checkUndoAllowed();
    const p = this.p;
    this.log(`「${(STEPS.find((s) => s.id === id) || {}).label}」を元に戻します`, 'cmd');
    switch (id) {
      case 'uv':
        // uv は実行時には使わないため、導入完了の記録は残す
        this.removeInRoot(p.uvDir);
        this.removeInRoot(p.uvCacheDir);
        break;
      case 'source':
        // .venv と models は残し、hayamimi のソースだけ削除する
        if (fs.existsSync(p.hayamimiDir)) {
          for (const n of fs.readdirSync(p.hayamimiDir)) {
            if (n !== '.venv' && n !== 'models') this.removeInRoot(path.join(p.hayamimiDir, n));
          }
        }
        this.removeInRoot(path.join(p.root, 'backup', 'source-previous'));
        this.clearMarker();
        break;
      case 'python':
        // 仮想環境（ライブラリを含む）と uv が用意した Python を削除する
        this.removeInRoot(p.venvDir);
        this.removeInRoot(p.pythonInstallDir);
        this.clearMarker();
        break;
      case 'deps': {
        // 仮想環境に入れたライブラリをすべてアンインストールする（Python 環境自体は残す）
        if (fs.existsSync(p.uvExe) && fs.existsSync(p.venvPython)) {
          let list = '';
          await run(p.uvExe, ['pip', 'freeze', '--python', p.venvPython], {
            env: this.uvEnv(),
            onLine: (l, stream) => { if (stream === 'stdout') list += `${l}\n`; },
          });
          const names = list.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
            .map((l) => l.split(/[=<>@ ;]/)[0]).filter(Boolean);
          if (names.length) {
            await this.exec(p.uvExe, ['pip', 'uninstall', '--python', p.venvPython, ...names], { env: this.uvEnv() });
          } else {
            this.log('アンインストールするライブラリはありません。');
          }
          this.removeInRoot(path.join(p.root, 'requirements-hayamimiwrapper.txt'));
        } else {
          // uv が無い場合はライブラリだけを個別に消せないため、仮想環境ごと削除する
          this.log('uv が無いため、仮想環境ごと削除します（Python 環境も作り直しになります）。', 'stderr');
          this.removeInRoot(p.venvDir);
        }
        this.clearMarker();
        break;
      }
      case 'models':
        this.removeInRoot(p.modelsDir);
        this.clearMarker();
        break;
      default:
        throw new Error(`不明な手順です: ${id}`);
    }
    this.log('元に戻しました。', 'success');
    return this.getStatus();
  }

  /** 保存場所を丸ごと削除する（すべての手順を元に戻す） */
  async undoAll() {
    this.checkUndoAllowed();
    const root = this.p.root;
    this.log(`保存場所をすべて削除します: ${root}`, 'cmd');
    fs.rmSync(root, { recursive: true, force: true });
    this.log('すべて削除しました。', 'success');
    return this.getStatus();
  }

  async step_uv({ report }) {
    const p = this.p;
    if (fs.existsSync(p.uvExe)) {
      const ver = await this.output(p.uvExe, ['--version'], this.uvEnv());
      if (ver && ver.startsWith(`uv ${PINNED.uvVersion}`)) {
        this.log(`uv ${PINNED.uvVersion} はすでに用意されています。`);
        return true;
      }
    }
    const asset = uvAssetName();
    const url = `https://github.com/astral-sh/uv/releases/download/${PINNED.uvVersion}/${asset}`;
    const archive = path.join(p.downloadsDir, asset);
    this.abort = new AbortController();
    this.log(`uv をダウンロードしています: ${url}`);
    await download(url, archive, (r, t) => report(t ? r / t : 0, `${formatBytes(r)} / ${formatBytes(t)}`),
      this.abort.signal, this.opener);
    const tmp = path.join(p.downloadsDir, 'uv-extract');
    fs.rmSync(tmp, { recursive: true, force: true });
    await extract(archive, tmp, (l) => this.log(l));
    const exeName = path.basename(p.uvExe);
    const found = findFile(tmp, exeName);
    if (!found) throw new Error(`展開したファイルに ${exeName} が見つかりません`);
    fs.mkdirSync(p.uvDir, { recursive: true });
    fs.copyFileSync(found, p.uvExe);
    if (process.platform !== 'win32') fs.chmodSync(p.uvExe, 0o755);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    return false;
  }

  async step_source({ report }) {
    const p = this.p;
    const short = PINNED.hayamimiCommit.slice(0, 7);
    if (fs.existsSync(p.transcribeScript) && this.sourceCommit() === PINNED.hayamimiCommit) {
      this.log(`hayamimi 本体（${short}）はすでにダウンロード済みです。`);
      return true;
    }
    const archive = path.join(p.downloadsDir, 'hayamimi-main.tar.gz');
    this.abort = new AbortController();
    this.log(`hayamimi（固定バージョン ${short}）をダウンロードしています: ${HAYAMIMI_TARBALL}`);
    await download(HAYAMIMI_TARBALL, archive, (r) => report(0.5, formatBytes(r)), this.abort.signal, this.opener);
    const tmp = path.join(p.downloadsDir, 'src-extract');
    fs.rmSync(tmp, { recursive: true, force: true });
    await extract(archive, tmp, (l) => this.log(l));
    const top = fs.readdirSync(tmp).find((n) => fs.statSync(path.join(tmp, n)).isDirectory());
    if (!top) throw new Error('hayamimi のアーカイブ構成が想定と異なります');
    // 既存の .venv / models は残し、それ以外の古いソースは backup/source-previous へ退避してから置き換える
    if (fs.existsSync(p.hayamimiDir)) {
      const prev = path.join(p.root, 'backup', 'source-previous');
      fs.rmSync(prev, { recursive: true, force: true });
      fs.mkdirSync(prev, { recursive: true });
      for (const name of fs.readdirSync(p.hayamimiDir)) {
        if (name === '.venv' || name === 'models') continue;
        fs.renameSync(path.join(p.hayamimiDir, name), path.join(prev, name));
      }
    }
    fs.cpSync(path.join(tmp, top), p.hayamimiDir, { recursive: true, force: true });
    fs.writeFileSync(path.join(p.hayamimiDir, SOURCE_STAMP),
      JSON.stringify({ commit: PINNED.hayamimiCommit, fetchedAt: new Date().toISOString() }, null, 2));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    return false;
  }

  async step_python({ report }) {
    const p = this.p;
    if (fs.existsSync(p.venvPython)) {
      const ver = await this.output(p.venvPython, ['--version'], this.baseEnv());
      if (ver === `Python ${PINNED.pythonVersion}`) {
        this.log(`Python ${PINNED.pythonVersion} の環境はすでに作成済みです。`);
        return true;
      }
    }
    report(0.1, `Python ${PINNED.pythonVersion} を準備しています（初回は数分かかります）`);
    await this.exec(p.uvExe, [
      'venv', p.venvDir, '--python', PINNED.pythonVersion, '--python-preference', 'only-managed', '--clear',
    ], { env: this.uvEnv(), cwd: p.hayamimiDir });
    return false;
  }

  async step_deps({ report }) {
    const p = this.p;
    report(0.05, 'ライブラリをインストールしています（数分かかることがあります）');
    // 不要な依存（kiwipiepy）を除いた requirements を作る
    const reqs = filterRequirements(fs.readFileSync(p.requirements, 'utf8'), EXCLUDED_PACKAGES);
    const reqFile = path.join(p.root, 'requirements-hayamimiwrapper.txt');
    fs.writeFileSync(reqFile, reqs, 'utf8');
    let count = 0;
    await this.exec(p.uvExe, ['pip', 'install', '-r', reqFile, '--python', p.venvPython], {
      env: this.uvEnv(),
      cwd: p.hayamimiDir,
      onLine: () => {
        count++;
        report(Math.min(0.95, 0.05 + count / 60), 'ライブラリをインストールしています');
      },
    });
    // 以前のバージョンで入れてしまった不要な依存を削除する（入っていなければ何もしない）
    await this.exec(p.uvExe, ['pip', 'uninstall', '--python', p.venvPython, ...EXCLUDED_PACKAGES], {
      env: this.uvEnv(),
      cwd: p.hayamimiDir,
    });
    return false;
  }

  async step_models({ modelSet, report }) {
    const p = this.p;
    const args = ['-u', p.downloadModelsScript];
    if (modelSet === 'minimal') args.push('--minimal');
    let current = '';
    await this.exec(p.venvPython, args, {
      cwd: p.hayamimiDir,
      env: { ...this.baseEnv(), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      onLine: (line) => {
        const get = /\[get \]\s*(.+)/.exec(line);
        if (get) current = get[1].trim();
        const pct = parsePercent(line);
        if (pct != null) {
          report(pct / 100, current ? `${current}: ${pct.toFixed(0)}%` : `${pct.toFixed(0)}%`, true);
        } else if (get) report(0, current, true);
      },
    });
    return false;
  }
}

module.exports = { Installer, STEPS, PINNED, uvAssetName, filterRequirements, ROOT_MARKER, EXCLUDED_PACKAGES };
