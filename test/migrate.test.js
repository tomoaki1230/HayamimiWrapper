'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateUserData, migrateRuntime } = require('../src/main/migrate');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hmw-mig-'));
}

test('設定は新しい側に無いときだけコピーする', () => {
  const base = tmp();
  try {
    const oldDir = path.join(base, 'Hayamimi3');
    const newDir = path.join(base, 'HayamimiWrapper');
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"a":1}');
    fs.writeFileSync(path.join(oldDir, 'Local State'), 'key');
    assert.equal(migrateUserData(oldDir, newDir), true);
    assert.equal(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'), '{"a":1}');
    assert.equal(fs.readFileSync(path.join(newDir, 'Local State'), 'utf8'), 'key');
    fs.writeFileSync(path.join(oldDir, 'settings.json'), '{"a":2}');
    assert.equal(migrateUserData(oldDir, newDir), false, '2 回目は上書きしない');
    assert.equal(fs.readFileSync(path.join(newDir, 'settings.json'), 'utf8'), '{"a":1}');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('実行環境を移動し、venv の旧パスを書き換える', () => {
  const base = tmp();
  try {
    const oldRoot = path.join(base, 'Hayamimi3');
    const newRoot = path.join(base, 'HayamimiWrapper');
    const venv = path.join(oldRoot, 'hayamimi', '.venv');
    const py = path.join(oldRoot, 'tools', 'python', 'bin', 'python3.11');
    fs.mkdirSync(path.dirname(py), { recursive: true });
    fs.writeFileSync(py, '');
    fs.mkdirSync(path.join(venv, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), `home = ${path.dirname(py)}\nversion = 3.11.17\n`);
    if (process.platform !== 'win32') fs.symlinkSync(py, path.join(venv, 'bin', 'python'));

    assert.equal(migrateRuntime(oldRoot, newRoot), 'moved');
    assert.ok(!fs.existsSync(oldRoot));
    const cfg = fs.readFileSync(path.join(newRoot, 'hayamimi', '.venv', 'pyvenv.cfg'), 'utf8');
    assert.ok(cfg.includes(path.join(newRoot, 'tools', 'python', 'bin')));
    assert.ok(!cfg.includes(oldRoot));
    if (process.platform !== 'win32') {
      const link = fs.readlinkSync(path.join(newRoot, 'hayamimi', '.venv', 'bin', 'python'));
      assert.equal(link, path.join(newRoot, 'tools', 'python', 'bin', 'python3.11'));
    }
    assert.equal(migrateRuntime(oldRoot, newRoot), 'none', '旧フォルダが無ければ何もしない');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('新しいフォルダがすでにあれば移動しない', () => {
  const base = tmp();
  try {
    fs.mkdirSync(path.join(base, 'old'));
    fs.mkdirSync(path.join(base, 'new'));
    assert.equal(migrateRuntime(path.join(base, 'old'), path.join(base, 'new')), 'none');
    assert.ok(fs.existsSync(path.join(base, 'old')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
