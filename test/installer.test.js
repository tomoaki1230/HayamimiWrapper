'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Installer, STEPS, PINNED, uvAssetName } = require('../src/main/installer');
const { runtimePaths } = require('../src/main/paths');

test('uv のアセット名が OS に合っている', () => {
  const name = uvAssetName();
  const expected = { win32: 'windows-msvc.zip', darwin: 'apple-darwin.tar.gz' }[process.platform]
    || 'unknown-linux-gnu.tar.gz';
  assert.ok(name.startsWith('uv-') && name.endsWith(expected), name);
});

test('手順の重みは合計 100', () => {
  assert.equal(STEPS.reduce((s, x) => s + x.weight, 0), 100);
});

test('未導入の環境では ready=false、必要ファイルが揃うと ready=true', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm3-'));
  try {
    const p = runtimePaths(root);
    const inst = new Installer(p);
    assert.equal(inst.getStatus().ready, false);
    for (const f of [p.transcribeScript, p.venvPython]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '');
    }
    fs.mkdirSync(p.modelsDir, { recursive: true });
    fs.writeFileSync(path.join(p.modelsDir, 'm.onnx'), '');
    fs.mkdirSync(path.join(p.venvDir, 'lib', 'python3.11', 'site-packages', 'sherpa_onnx'), { recursive: true });
    assert.equal(inst.getStatus().ready, false, 'マーカーがなければ未完了');
    fs.writeFileSync(p.marker, JSON.stringify({ modelSet: 'full', installedAt: 'x' }));
    assert.equal(inst.getStatus().ready, false, '固定バージョンの記録がなければ未完了');
    const stamp = path.join(p.hayamimiDir, '.hayamimiwrapper-source.json');
    fs.writeFileSync(stamp, JSON.stringify({ commit: 'deadbeef' }));
    assert.equal(inst.getStatus().ready, false, '別バージョンの hayamimi は未完了扱い');
    fs.writeFileSync(stamp, JSON.stringify({ commit: PINNED.hayamimiCommit }));
    const st = inst.getStatus();
    assert.equal(st.ready, true);
    assert.equal(st.modelSet, 'full');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('バージョンは固定されている（最新版の自動取得をしない）', () => {
  assert.match(PINNED.hayamimiCommit, /^[0-9a-f]{40}$/);
  assert.match(PINNED.uvVersion, /^\d+\.\d+\.\d+$/);
  assert.match(PINNED.pythonVersion, /^3\.11\.\d+$/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'installer.js'), 'utf8');
  assert.ok(!/releases\/latest|refs\/heads/.test(src), 'latest / ブランチ指定の URL を使っていない');
});
