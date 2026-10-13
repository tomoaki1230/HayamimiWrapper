'use strict';

/**
 * Windows 版ビルド用に、ffmpeg-static と同じリリースの Windows 版 ffmpeg.exe を取得する。
 * Linux / WSL からビルドしても Windows 用の ffmpeg が同梱されるようにするためのスクリプト。
 * 取得先: node_modules/ffmpeg-static/ffmpeg.exe（実行時に ffmpeg-static が win32 で参照する場所）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const pkgDir = path.dirname(require.resolve('ffmpeg-static/package.json'));
const pkg = require(path.join(pkgDir, 'package.json'));
const release = pkg['ffmpeg-static']['binary-release-tag'];
const base = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}`;
const dest = path.join(pkgDir, 'ffmpeg.exe');

async function fetchTo(url, file, gunzip) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`ダウンロード失敗 (${res.status}): ${url}`);
  const tmp = `${file}.part`;
  const streams = [Readable.fromWeb(res.body)];
  if (gunzip) streams.push(zlib.createGunzip());
  streams.push(fs.createWriteStream(tmp));
  await pipeline(...streams);
  fs.renameSync(tmp, file);
}

(async () => {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 10 * 1024 * 1024) {
    console.log(`Windows 版 ffmpeg は取得済みです: ${dest}`);
    return;
  }
  console.log(`Windows 版 ffmpeg (${release}) を取得しています…`);
  await fetchTo(`${base}/ffmpeg-win32-x64.gz`, dest, true);
  await fetchTo(`${base}/win32-x64.LICENSE`, path.join(pkgDir, 'ffmpeg-win32-x64.LICENSE'), false);
  // PE 形式（MZ ヘッダー）であることを確認
  const head = Buffer.alloc(2);
  const fd = fs.openSync(dest, 'r');
  fs.readSync(fd, head, 0, 2, 0);
  fs.closeSync(fd);
  if (head.toString('latin1') !== 'MZ') throw new Error('取得したファイルが Windows 実行ファイルではありません');
  console.log(`取得しました: ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)}MB)`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
