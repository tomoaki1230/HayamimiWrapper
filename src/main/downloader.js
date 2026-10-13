'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { run } = require('./proc');

/**
 * HTTP ダウンロード（進捗通知つき）とアーカイブ展開。
 * 展開には OS 標準の tar を使う（Windows 10 以降は System32\tar.exe が zip も展開できる）。
 */

/**
 * Node.js 標準の fetch で接続する（テスト・Electron 外用。プロキシ設定は反映されない）。
 * @returns {Promise<{status: number, statusText: string, contentLength: number, stream: import('stream').Readable}>}
 */
async function fetchOpener(url, signal) {
  const res = await fetch(url, { redirect: 'follow', signal });
  return {
    status: res.status,
    statusText: res.statusText,
    contentLength: Number(res.headers.get('content-length')) || 0,
    stream: res.body ? Readable.fromWeb(res.body) : Readable.from([]),
  };
}

/**
 * Electron の net（Chromium の通信機能）で接続する opener を作る。
 * session のプロキシ設定（OS 設定・PAC・手動指定）に従い、プロキシ認証にも応答する。
 * @param {Electron.Net} net
 * @param {() => ({username: string, password: string} | null)} getCredentials
 */
function createElectronOpener(net, getCredentials) {
  return (url, signal) => new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow', useSessionCookies: false, cache: 'no-store' });
    let authTries = 0;
    req.on('login', (authInfo, callback) => {
      const creds = getCredentials ? getCredentials() : null;
      if (authInfo.isProxy && creds && authTries++ < 2) callback(creds.username, creds.password);
      else callback();
    });
    req.on('response', (res) => {
      const len = res.headers['content-length'];
      resolve({
        status: res.statusCode,
        statusText: res.statusMessage || '',
        contentLength: Number(Array.isArray(len) ? len[0] : len) || 0,
        stream: res,
      });
    });
    req.on('error', (err) => reject(new Error(`接続できませんでした: ${err.message}`)));
    if (signal) {
      if (signal.aborted) { req.abort(); reject(new Error('キャンセルされました')); return; }
      signal.addEventListener('abort', () => {
        req.abort();
        reject(new Error('キャンセルされました'));
      }, { once: true });
    }
    req.end();
  });
}

/**
 * @param {string} url
 * @param {string} dest 保存先ファイル
 * @param {(received: number, total: number) => void} [onProgress]
 * @param {AbortSignal} [signal]
 * @param {typeof fetchOpener} [opener] 接続方法（既定は Node.js の fetch）
 * @param {number} [idleMs] データが届かない状態がこの時間続いたら中断する（既定 60 秒。通信が止まって永久に待つのを防ぐ）
 */
async function download(url, dest, onProgress, signal, opener = fetchOpener, idleMs = 60000) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 呼び出し元の中止と、通信が止まったときの中断の両方で止められるようにする
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let res = null;
  let idle = false;
  let idleTimer = null;
  const arm = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idle = true;
      ac.abort();
      if (res && res.stream && !res.stream.destroyed) res.stream.destroy(new Error('idle'));
    }, idleMs);
  };
  const explain = (err) => {
    if (idle) {
      return new Error(`通信が ${Math.round(idleMs / 1000)} 秒以上止まったため、ダウンロードを中断しました。`
        + `インターネット接続（会社のネットワークではプロキシ設定）を確認して、もう一度お試しください: ${url}`);
    }
    if (signal && signal.aborted) return new Error('キャンセルされました');
    return err;
  };
  const tmp = `${dest}.part`;
  try {
    arm();
    try {
      res = await opener(url, ac.signal);
    } catch (err) {
      throw explain(err);
    }
    if (res.status === 407) {
      res.stream.destroy();
      throw new Error('プロキシの認証に失敗しました（407）。「ネットワーク」画面のプロキシのユーザー名・パスワードを確認してください。');
    }
    if (res.status < 200 || res.status >= 300) {
      res.stream.destroy();
      throw new Error(`ダウンロードに失敗しました (${res.status} ${res.statusText}): ${url}`);
    }
    const total = res.contentLength;
    let received = 0;
    let lastNotify = 0;
    res.stream.on('data', (chunk) => {
      received += chunk.length;
      arm();
      const now = Date.now();
      if (onProgress && now - lastNotify > 200) {
        lastNotify = now;
        onProgress(received, total);
      }
    });
    try {
      await pipeline(res.stream, fs.createWriteStream(tmp));
    } catch (err) {
      const e = explain(err);
      if (e !== err) throw e;
      throw new Error(`ダウンロードが途中で切れました（${err.message}）。もう一度お試しください: ${url}`);
    }
    // 予告されたサイズより早く終わった（途中で切れた）ものを完成品として扱わない
    if (total && received !== total) {
      throw new Error(`ダウンロードが途中で切れました（${received} / ${total} バイト）。もう一度お試しください: ${url}`);
    }
    if (onProgress) onProgress(received, total || received);
    fs.renameSync(tmp, dest);
    return dest;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function tarCommand() {
  if (process.platform === 'win32') {
    // Git for Windows などの GNU tar を避け、OS 標準の bsdtar を使う
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

/**
 * アーカイブを destDir へ展開する。
 * ドライブレター（C:）を含むパスを tar が誤解しないよう、cwd を展開先にして相対名で渡す。
 */
async function extract(archive, destDir, onLine) {
  fs.mkdirSync(destDir, { recursive: true });
  const local = path.join(destDir, path.basename(archive));
  if (path.resolve(local) !== path.resolve(archive)) fs.copyFileSync(archive, local);
  try {
    await run(tarCommand(), ['-xf', path.basename(archive)], { cwd: destDir, onLine });
  } finally {
    if (path.resolve(local) !== path.resolve(archive)) fs.rmSync(local, { force: true });
  }
}

/** ディレクトリ内からファイル名が一致する最初のファイルを探す */
function findFile(dir, name) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isFile() && ent.name === name) return p;
    if (ent.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

module.exports = { download, extract, findFile, fetchOpener, createElectronOpener };
