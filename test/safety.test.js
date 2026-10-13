'use strict';

/** 既存の環境を壊さないための仕組み（環境変数の分離・保存場所の確認・不要依存の除外） */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isolatedEnv, uvIsolation } = require('../src/main/env');
const { Installer, filterRequirements, ROOT_MARKER } = require('../src/main/installer');
const { runtimePaths, resolveChosenRoot } = require('../src/main/paths');

test('別の Python 環境の設定を子プロセスへ持ち込まない', () => {
  const env = isolatedEnv({ PATH: '/bin', PythonPath: '/x', VIRTUAL_ENV: '/v', uv_index_url: 'http://i', HOME: '/h' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/h');
  assert.ok(!('PythonPath' in env), '大文字小文字が違っても削除する');
  assert.ok(!('VIRTUAL_ENV' in env));
  assert.ok(!('uv_index_url' in env));
  assert.equal(env.PYTHONNOUSERSITE, '1');
});

test('uv はレジストリ・PATH・ユーザー設定に触れない設定で動かす', () => {
  const u = uvIsolation({ pythonInstallDir: '/r/tools/python', cacheDir: '/r/tools/uv-cache' });
  assert.equal(u.UV_PYTHON_INSTALL_REGISTRY, '0');
  assert.equal(u.UV_PYTHON_INSTALL_BIN, '0');
  assert.equal(u.UV_NO_CONFIG, '1');
  assert.equal(u.UV_PYTHON_INSTALL_DIR, '/r/tools/python');
});

test('requirements から kiwipiepy を除く', () => {
  const src = 'numpy==2.4.6\n# comment kiwipiepy\nKiwiPiePy==0.23.2 ; sys_platform == "win32"\nkiwipiepy_model==1\nsherpa-onnx==1.13.6\n';
  const out = filterRequirements(src, ['kiwipiepy', 'kiwipiepy-model']);
  assert.ok(out.includes('numpy==2.4.6'));
  assert.ok(out.includes('sherpa-onnx==1.13.6'));
  assert.ok(out.includes('# comment kiwipiepy'), 'コメントは残す');
  assert.ok(!/^kiwipiepy/im.test(out));
});

test('アプリが作っていない hayamimi フォルダがある場所ではセットアップを中止する', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-guard-'));
  try {
    const p = runtimePaths(root);
    fs.mkdirSync(p.hayamimiDir, { recursive: true });
    fs.writeFileSync(path.join(p.hayamimiDir, 'my-work.py'), 'print(1)');
    const inst = new Installer(p);
    assert.throws(() => inst.guardRoot(), /上書きしないよう中止/);
    assert.ok(fs.existsSync(path.join(p.hayamimiDir, 'my-work.py')), 'ユーザーのファイルはそのまま');
    assert.ok(!fs.existsSync(path.join(root, ROOT_MARKER)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('空の場所・アプリが管理する場所では印を書いて続行する', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-guard-'));
  try {
    const inst = new Installer(runtimePaths(root));
    inst.guardRoot();
    assert.ok(fs.existsSync(path.join(root, ROOT_MARKER)));
    assert.equal(inst.ownsRoot(), true);
    inst.guardRoot(); // 2 回目も問題なし
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('既存のファイルがあるフォルダを選んだら、中に専用フォルダを作る', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-choose-'));
  try {
    assert.equal(resolveChosenRoot(base), base, '空ならそのまま');
    fs.writeFileSync(path.join(base, 'document.txt'), 'x');
    assert.equal(resolveChosenRoot(base), path.join(base, 'HayamimiWrapper'));
    fs.writeFileSync(path.join(base, ROOT_MARKER), '');
    assert.equal(resolveChosenRoot(base), base, 'アプリが管理する場所ならそのまま');
    assert.equal(resolveChosenRoot(path.join(base, 'new')), path.join(base, 'new'), '存在しない場所はそのまま');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('ASCII 以外の文字を含むパスを判定する（Windows の保存場所の代替先判定用）', () => {
  const { hasNonAscii, asciiFallbackRoot } = require('../src/main/paths');
  assert.equal(hasNonAscii('C:\\Users\\taro\\AppData\\Local\\HayamimiWrapper'), false);
  assert.equal(hasNonAscii('C:\\Users\\山田\\AppData\\Local\\HayamimiWrapper'), true);
  assert.ok(asciiFallbackRoot().endsWith('HayamimiWrapper'));
  assert.equal(hasNonAscii(asciiFallbackRoot()), false);
});
