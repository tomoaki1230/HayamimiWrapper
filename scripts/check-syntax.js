'use strict';

/**
 * 構文チェック: src/ 配下の JavaScript を node --check で検査し、
 * Python ラッパーが存在することを確認する。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

let failed = 0;
const files = walk(path.join(root, 'src')).concat(walk(path.join(root, 'test')));
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(`NG ${path.relative(root, file)}\n${r.stderr}`);
  }
}

const runner = path.join(root, 'src', 'python', 'hayamimi_runner.py');
if (!fs.existsSync(runner)) {
  failed++;
  console.error('NG src/python/hayamimi_runner.py が見つかりません');
}

if (failed) {
  console.error(`構文チェック失敗: ${failed} 件`);
  process.exit(1);
}
console.log(`構文チェック OK（${files.length} ファイル）`);
