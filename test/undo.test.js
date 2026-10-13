'use strict';

/** 各手順の「元に戻す」（保存場所の中だけを削除すること） */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Installer, ROOT_MARKER } = require('../src/main/installer');
const { runtimePaths } = require('../src/main/paths');

function touch(f, body = 'x') {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

/** 導入済みの模擬環境を作る */
function fakeInstall() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-undo-'));
  const root = path.join(base, 'root');
  const p = runtimePaths(root);
  touch(path.join(root, ROOT_MARKER));
  touch(p.uvExe);
  touch(path.join(p.uvCacheDir, 'c'));
  touch(p.transcribeScript);
  touch(path.join(p.hayamimiDir, 'README.md'));
  touch(path.join(p.pythonInstallDir, 'cpython', 'python'));
  touch(p.venvPython);
  touch(path.join(p.venvDir, 'lib', 'python3.11', 'site-packages', 'sherpa_onnx', '__init__.py'));
  touch(path.join(p.modelsDir, 'model.onnx'));
  touch(p.marker, JSON.stringify({ modelSet: 'minimal' }));
  touch(path.join(base, 'outside.txt'), 'ユーザーのファイル');
  return { base, root, p, inst: new Installer(p) };
}

test('手順ごとに削除し、保存場所の外には触れない', async () => {
  const { base, p, inst } = fakeInstall();
  try {
    assert.deepEqual(inst.getStatus().present, { uv: true, source: true, python: true, deps: true, models: true });

    await inst.undoStep('uv');
    assert.ok(!fs.existsSync(p.uvExe) && !fs.existsSync(p.uvCacheDir));
    assert.ok(fs.existsSync(p.marker), 'uv は実行時に使わないので導入完了の記録は残す');

    await inst.undoStep('models');
    assert.ok(!fs.existsSync(p.modelsDir));
    assert.equal(inst.getStatus().ready, false);

    await inst.undoStep('source');
    assert.ok(!fs.existsSync(p.transcribeScript));
    assert.ok(fs.existsSync(p.venvPython), 'ソースを消しても Python 環境は残る');

    await inst.undoStep('deps'); // uv が無いので仮想環境ごと削除される
    assert.ok(!fs.existsSync(p.venvDir));

    await inst.undoStep('python');
    assert.ok(!fs.existsSync(p.pythonInstallDir));
    assert.deepEqual(inst.getStatus().present, { uv: false, source: false, python: false, deps: false, models: false });
    assert.ok(fs.existsSync(path.join(base, 'outside.txt')), '保存場所の外のファイルはそのまま');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('すべて削除は保存場所だけを消す', async () => {
  const { base, root, inst } = fakeInstall();
  try {
    await inst.undoAll();
    assert.ok(!fs.existsSync(root));
    assert.ok(fs.existsSync(path.join(base, 'outside.txt')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('アプリが作っていない保存場所では削除しない', async () => {
  const { base, root, p, inst } = fakeInstall();
  try {
    fs.rmSync(path.join(root, ROOT_MARKER));
    fs.rmSync(p.marker);
    fs.rmSync(path.join(p.hayamimiDir, '.hayamimiwrapper-source.json'), { force: true });
    await assert.rejects(() => inst.undoStep('models'), /削除しません/);
    await assert.rejects(() => inst.undoAll(), /削除しません/);
    assert.ok(fs.existsSync(p.modelsDir));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('保存場所の外のパスは削除を拒否する', () => {
  const { base, inst } = fakeInstall();
  try {
    assert.throws(() => inst.removeInRoot(path.join(base, 'outside.txt')), /保存場所の外/);
    assert.throws(() => inst.removeInRoot(inst.p.root), /保存場所の外/, '保存場所そのものも個別削除の対象外');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
