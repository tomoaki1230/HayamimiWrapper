'use strict';

// ダウンロードの異常系: 404・途中で切断・通信が止まる・中止。不完全なファイルを完成扱いにしないこと
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { download } = require('../src/main/downloader');

const SIZE = 256 * 1024;
let server; let base; const sockets = new Set();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm3-dl-test-'));

test.before(async () => {
  server = http.createServer((req, res) => {
    const body = Buffer.alloc(SIZE, 1);
    if (req.url === '/ok') { res.writeHead(200, { 'Content-Length': SIZE }); res.end(body); }
    else if (req.url === '/404') { res.writeHead(404); res.end(); }
    else if (req.url === '/trunc') { res.writeHead(200, { 'Content-Length': SIZE }); res.write(body.subarray(0, 1000)); setTimeout(() => res.socket.destroy(), 50); }
    else if (req.url === '/stall') { res.writeHead(200, { 'Content-Length': SIZE }); res.write(body.subarray(0, 1000)); }
    else if (req.url === '/slow') { res.writeHead(200, { 'Content-Length': SIZE }); const t = setInterval(() => (res.destroyed ? clearInterval(t) : res.write(body.subarray(0, 100))), 20); }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { sockets.forEach((s) => s.destroy()); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const dest = (n) => path.join(dir, `${n}.bin`);

test('正常にダウンロードできる', async () => {
  await download(`${base}/ok`, dest('ok'));
  assert.equal(fs.statSync(dest('ok')).size, SIZE);
  assert.ok(!fs.existsSync(`${dest('ok')}.part`));
});

test('404 は分かりやすいエラーになり、ファイルを作らない', async () => {
  await assert.rejects(download(`${base}/404`, dest('404')), /ダウンロードに失敗しました \(404/);
  assert.ok(!fs.existsSync(dest('404')));
});

test('途中で切れたら失敗にし、不完全なファイルを完成扱いにしない', async () => {
  await assert.rejects(download(`${base}/trunc`, dest('trunc')), /途中で切れました/);
  assert.ok(!fs.existsSync(dest('trunc')) && !fs.existsSync(`${dest('trunc')}.part`));
});

test('データが届かなくなったら一定時間で中断する（永久に待たない）', async () => {
  const t0 = Date.now();
  await assert.rejects(download(`${base}/stall`, dest('stall'), null, undefined, undefined, 300), /秒以上止まった/);
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(!fs.existsSync(dest('stall')));
});

test('中止するとキャンセル扱いで終わる', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(download(`${base}/slow`, dest('slow'), null, ac.signal), /キャンセルされました/);
  assert.ok(!fs.existsSync(dest('slow')));
});
