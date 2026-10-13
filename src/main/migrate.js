'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 旧名称（Hayamimi3）からの引き継ぎ。
 * - 設定（userData/settings.json と、safeStorage の鍵を含む Local State）をコピー
 * - 実行環境（hayamimi・Python・モデル。既定の保存場所を使っていた場合のみ）を新しい名前のフォルダへ移動
 *   移動後は venv の pyvenv.cfg / シンボリックリンクに残る旧パスを書き換える。
 *   移動できない場合（使用中など）は、旧フォルダをそのまま使うよう設定する。
 */

const LEGACY_NAME = 'Hayamimi3';

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 設定ファイル類を旧 userData から新 userData へコピーする（新しい側に無い場合のみ） */
function migrateUserData(oldDir, newDir) {
  if (!exists(path.join(oldDir, 'settings.json')) || exists(path.join(newDir, 'settings.json'))) return false;
  fs.mkdirSync(newDir, { recursive: true });
  for (const name of ['settings.json', 'Local State']) {
    const src = path.join(oldDir, name);
    const dst = path.join(newDir, name);
    if (exists(src) && !exists(dst)) fs.copyFileSync(src, dst);
  }
  return true;
}

/** venv 内に残る旧ルートのパスを新ルートへ書き換える */
function fixVenvPaths(venvDir, oldRoot, newRoot) {
  const cfg = path.join(venvDir, 'pyvenv.cfg');
  if (exists(cfg)) {
    const text = fs.readFileSync(cfg, 'utf8');
    const variants = [oldRoot, oldRoot.replace(/\\/g, '/'), oldRoot.replace(/\//g, '\\')];
    let next = text;
    for (const v of new Set(variants)) next = next.split(v).join(newRoot);
    if (next !== text) fs.writeFileSync(cfg, next, 'utf8');
  }
  // POSIX の venv は bin/python がベース Python への絶対パスのシンボリックリンク
  relinkDir(path.join(venvDir, 'bin'), oldRoot, newRoot);
}

/**
 * dir 直下のシンボリックリンク / ジャンクションのうち、旧ルートを指すものを新ルートへ張り直す。
 * uv は「cpython-3.11-…」→「cpython-3.11.17-…」のような絶対パスのリンク（Windows ではジャンクション）を作る。
 */
function relinkDir(dir, oldRoot, newRoot) {
  if (!exists(dir)) return;
  const norm = (p) => (process.platform === 'win32' ? p.replace(/^\\\\\?\\/, '').toLowerCase() : p);
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let target;
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) continue;
      target = fs.readlinkSync(p);
    } catch {
      continue;
    }
    const cleaned = process.platform === 'win32' ? target.replace(/^\\\\\?\\/, '') : target;
    if (!norm(cleaned).startsWith(norm(oldRoot))) continue;
    const next = newRoot + cleaned.slice(oldRoot.length);
    const isDir = (() => { try { return fs.statSync(next).isDirectory(); } catch { return false; } })();
    fs.unlinkSync(p);
    fs.symlinkSync(next, p, isDir ? 'junction' : 'file');
  }
}

/**
 * 実行環境フォルダを移動する。
 * @returns {'moved' | 'kept-legacy' | 'none'}
 */
function migrateRuntime(oldRoot, newRoot, log = () => {}) {
  if (!exists(oldRoot) || exists(newRoot)) return 'none';
  try {
    fs.mkdirSync(path.dirname(newRoot), { recursive: true });
    fs.renameSync(oldRoot, newRoot);
  } catch (e) {
    log(`旧フォルダを移動できなかったため、そのまま使います: ${oldRoot} (${e.message})`);
    return 'kept-legacy';
  }
  try {
    relinkDir(path.join(newRoot, 'tools', 'python'), oldRoot, newRoot);
    fixVenvPaths(path.join(newRoot, 'hayamimi', '.venv'), oldRoot, newRoot);
  } catch (e) {
    log(`Python 環境のパス書き換えに失敗しました（「修復」で作り直せます）: ${e.message}`);
  }
  log(`旧フォルダを移動しました: ${oldRoot} → ${newRoot}`);
  return 'moved';
}

module.exports = { LEGACY_NAME, migrateUserData, migrateRuntime, fixVenvPaths, relinkDir };
