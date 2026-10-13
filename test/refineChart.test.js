'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RefineLagTracker, niceMax } = require('../src/renderer/refineChart');

test('遅れ = 清書の到着 − まとめた速報のうち最も早い到着', () => {
  const tr = new RefineLagTracker();
  tr.onFinal(1, 1000);
  tr.onFinal(2, 3000);
  tr.onFinal(3, 6000);
  assert.equal(tr.pending, 3);
  const p = tr.onRefine([1, 2], 8000);
  assert.equal(p.delay, 7);
  assert.equal(p.count, 2);
  assert.equal(tr.pending, 1);
  assert.equal(tr.oldestWait(10000), 4, '残っている速報 3 は 6 秒時点から待っている');
  assert.equal(tr.onRefine([99], 9000), null, '知らない速報だけの清書は無視');
});

test('清書待ち件数の推移（ステップ）と統計', () => {
  const tr = new RefineLagTracker();
  tr.onFinal(1, 1000);
  tr.onFinal(2, 2000);
  tr.onRefine([1, 2], 5000);
  assert.equal(tr.pendingAt(500), 0);
  assert.equal(tr.pendingAt(1500), 1);
  assert.equal(tr.pendingAt(4000), 2);
  assert.equal(tr.pendingAt(6000), 0);
  const s = tr.stats(6000);
  assert.equal(s.latest, 4);
  assert.equal(s.behind, false);
});

test('処理が追いついていない状態を判定する', () => {
  const tr = new RefineLagTracker();
  tr.onFinal(1, 0);
  assert.equal(tr.stats(10000).behind, false);
  assert.equal(tr.stats(31000).behind, true, '30 秒以上清書されていない');
  const tr2 = new RefineLagTracker();
  for (let i = 1; i <= 10; i++) tr2.onFinal(i, i);
  assert.equal(tr2.stats(100).behind, true, '10 件以上たまっている');
});

test('目盛りの最大値はきりのよい値', () => {
  assert.equal(niceMax(3, 10), 10);
  assert.equal(niceMax(13, 10), 20);
  assert.equal(niceMax(23, 10), 25);
  assert.equal(niceMax(2, 4), 5);
});

test('清書なしの速報は清書待ちから外す（遅れの点は付けない）', () => {
  const tr = new RefineLagTracker();
  tr.onFinal(1, 0); tr.onFinal(2, 0);
  assert.equal(tr.onSkip([1, 9], 1000), 1);
  assert.equal(tr.pending, 1);
  assert.equal(tr.points.length, 0);
});

test('最も古い清書待ちの待ち時間は、清書が届くと下がり、清書待ちがなければ 0', () => {
  const tr = new RefineLagTracker();
  tr.onFinal(1, 1000);
  tr.onFinal(2, 4000);
  assert.equal(tr.waitAt(500), 0);
  assert.equal(tr.waitAt(3000), 2);
  tr.onRefine([1], 6000);
  assert.equal(tr.waitAt(5999), 4.999, '清書の直前は速報 1 の待ち時間');
  assert.equal(tr.waitAt(6000), 2, '清書の後は速報 2 の待ち時間');
  tr.onRefine([2], 7000);
  assert.equal(tr.waitAt(7000), 0, '清書待ちがなくなったら 0');
  assert.equal(tr.waitAt(60000), 0);
});
