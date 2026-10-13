'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 実行環境（hayamimi 本体・Python・モデル）の配置パスを計算する。
 * モデルは数GBになるため、Windows では移動プロファイル（Roaming）ではなく LOCALAPPDATA に置く。
 */

const APP_DIR_NAME = 'HayamimiWrapper';

/** ASCII 以外の文字（日本語のユーザー名など）を含むか */
function hasNonAscii(p) {
  return /[^\x00-\x7F]/.test(String(p || ''));
}

/**
 * Windows で ASCII 以外の文字を含むパスに保存場所を置かないための代替先（C:\HayamimiWrapper）。
 * 音声認識エンジン（sherpa-onnx / ONNX Runtime）は、パスの文字によってはモデルを読み込めないことがあるため。
 */
function asciiFallbackRoot() {
  const drive = process.env.SystemDrive || 'C:';
  return path.join(`${drive}\\`, APP_DIR_NAME);
}

function defaultRuntimeRoot(app) {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const local = path.join(process.env.LOCALAPPDATA, APP_DIR_NAME);
    // ユーザー名に日本語などが含まれる場合は C:\HayamimiWrapper を使う（すでにそこへ導入済みならそのまま）
    if (hasNonAscii(local) && !fs.existsSync(path.join(local, 'install-state.json'))) return asciiFallbackRoot();
    return local;
  }
  return path.join(app.getPath('userData'), 'runtime');
}

/** 旧名称（Hayamimi3）時代の既定の保存場所 */
function legacyRuntimeRoot(app, legacyName) {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, legacyName);
  }
  return path.join(app.getPath('appData'), legacyName, 'runtime');
}

/**
 * @param {string} root 実行環境のルート
 */
function runtimePaths(root) {
  const isWin = process.platform === 'win32';
  const hayamimiDir = path.join(root, 'hayamimi');
  const venvDir = path.join(hayamimiDir, '.venv');
  return {
    root,
    toolsDir: path.join(root, 'tools'),
    uvDir: path.join(root, 'tools', 'uv'),
    uvExe: path.join(root, 'tools', 'uv', isWin ? 'uv.exe' : 'uv'),
    pythonInstallDir: path.join(root, 'tools', 'python'),
    uvCacheDir: path.join(root, 'tools', 'uv-cache'),
    downloadsDir: path.join(root, 'downloads'),
    workDir: path.join(root, 'work'),
    hayamimiDir,
    venvDir,
    venvPython: isWin
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python'),
    requirements: path.join(hayamimiDir, 'requirements.txt'),
    transcribeScript: path.join(hayamimiDir, 'scripts', 'realtime_transcribe.py'),
    downloadModelsScript: path.join(hayamimiDir, 'scripts', 'download_models.py'),
    modelsDir: path.join(hayamimiDir, 'models'),
    runnerScript: path.join(root, 'hayamimi_runner.py'),
    replaceFile: path.join(root, 'replace.txt'),
    marker: path.join(root, 'install-state.json'),
  };
}

/**
 * ユーザーが選んだフォルダから、実際の保存場所を決める。
 * 空のフォルダ、またはアプリが管理しているフォルダならそのまま使い、
 * それ以外（既存のファイルがある場所）なら中に専用フォルダ「HayamimiWrapper」を作って使う。
 */
function resolveChosenRoot(dir, markerName = '.hayamimiwrapper-root') {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return dir; // まだ存在しない場所
  }
  const owned = entries.includes(markerName) || entries.includes('install-state.json');
  if (entries.length === 0 || owned) return dir;
  return path.join(dir, APP_DIR_NAME);
}

module.exports = {
  defaultRuntimeRoot, legacyRuntimeRoot, runtimePaths, resolveChosenRoot, hasNonAscii, asciiFallbackRoot, APP_DIR_NAME,
};
