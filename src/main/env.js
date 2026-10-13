'use strict';

/**
 * 子プロセス（uv・Python）用の環境変数。
 * ユーザーが別に使っている Python / uv / conda の設定がアプリの環境に混ざらないように、
 * またアプリの処理がそれらへ影響しないように分離する。
 */

// 継承すると別の Python 環境を参照・変更してしまうおそれがある変数
const STRIP_KEYS = [
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONEXECUTABLE',
  'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'CONDA_PYTHON_EXE',
  'PIP_REQUIRE_VIRTUALENV', 'PIP_TARGET', 'PIP_PREFIX', 'PIP_USER',
  'UV_PYTHON', 'UV_SYSTEM_PYTHON', 'UV_PROJECT_ENVIRONMENT', 'UV_INDEX', 'UV_INDEX_URL',
  'UV_EXTRA_INDEX_URL', 'UV_DEFAULT_INDEX', 'UV_FIND_LINKS', 'UV_CONSTRAINT', 'UV_OVERRIDE',
  'UV_CACHE_DIR', 'UV_PYTHON_INSTALL_DIR', 'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_PYTHON_BIN_DIR',
];

/** 環境変数を大文字小文字を区別せずに削除する（Windows の環境変数は大文字小文字を区別しない） */
function stripKeys(env, keys) {
  const set = new Set(keys.map((k) => k.toUpperCase()));
  for (const k of Object.keys(env)) {
    if (set.has(k.toUpperCase())) delete env[k];
  }
  return env;
}

/** Python 実行用の分離された環境変数 */
function isolatedEnv(base = process.env) {
  const env = stripKeys({ ...base }, STRIP_KEYS);
  env.PYTHONNOUSERSITE = '1'; // ユーザーの site-packages（%APPDATA%\Python）を読み込まない
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUTF8 = '1';
  return env;
}

/** uv 用の追加設定: 保存場所の外（レジストリ・PATH・ユーザー設定）に触れない */
function uvIsolation({ pythonInstallDir, cacheDir }) {
  return {
    UV_PYTHON_INSTALL_DIR: pythonInstallDir,
    UV_CACHE_DIR: cacheDir,
    UV_NO_CONFIG: '1', // ユーザーの uv.toml / pyproject の設定を読まない
    UV_PYTHON_INSTALL_REGISTRY: '0', // Windows レジストリ（PEP 514）へ Python を登録しない
    UV_PYTHON_INSTALL_BIN: '0', // ~/.local/bin などへ python 実行ファイルを置かない
    UV_NO_PROGRESS: '1',
    // 社内プロキシ等で独自の証明書を使う環境でも通るよう、OS の証明書ストアを使う
    UV_NATIVE_TLS: '1',
  };
}

module.exports = { isolatedEnv, uvIsolation, stripKeys, STRIP_KEYS };
