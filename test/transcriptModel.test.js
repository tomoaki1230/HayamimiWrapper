'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TranscriptModel } = require('../src/renderer/transcriptView');

test('partial → final → translation → refine の流れ', () => {
  const m = new TranscriptModel();
  assert.equal(m.apply({ type: 'partial', text: 'こん' }).kind, 'partial');
  assert.equal(m.partial, 'こん');
  m.apply({ type: 'final', text: 'こんにちは', lang: 'ja', latency_ms: 123.4 });
  assert.equal(m.partial, '');
  assert.equal(m.finals[0].latency, 123);
  m.apply({ type: 'translation', lang: 'en', text: 'Hello' });
  assert.deepEqual(m.finals[0].translations, [{ lang: 'en', text: 'Hello' }]);
  m.apply({ type: 'refine', text: 'こんにちは。', lang: 'ja', speaker: 'S1' });
  assert.equal(m.refined.length, 1);
  assert.equal(m.entries(), m.refined, '清書があれば清書を優先');
  assert.equal(m.toPlainText('refined'), '[S1] こんにちは。');
});

test('不要なイベントや空文字は無視する', () => {
  const m = new TranscriptModel();
  assert.equal(m.apply({ type: 'final', text: '  ' }), null);
  assert.equal(m.apply({ type: 'translation', text: 'x' }), null);
  assert.equal(m.apply({ type: 'model_load' }), null);
  assert.equal(m.apply(null), null);
  assert.equal(m.entries(), m.finals);
});

test('話者ラベルから背景色の番号を決める（暫定表示の ? は同じ色）', () => {
  const { speakerColorIndex } = require('../src/renderer/transcriptView');
  assert.equal(speakerColorIndex('S1'), 0);
  assert.equal(speakerColorIndex('S2?'), 1);
  assert.equal(speakerColorIndex('S2'), 1);
  assert.equal(speakerColorIndex('S9'), 0, '8 色で循環');
  assert.equal(speakerColorIndex(''), null);
});

test('清書がまとめた速報に「清書済み」の印を付ける', () => {
  const m = new TranscriptModel();
  m.apply({ type: 'final', text: 'あ', seg_id: 1 });
  m.apply({ type: 'final', text: 'い', seg_id: 2 });
  m.apply({ type: 'final', text: 'う', seg_id: 3 });
  const ch = m.apply({ type: 'refine', text: 'あい', covers: [1, 2] });
  assert.deepEqual(ch.covered.map((e) => e.text), ['あ', 'い']);
  assert.deepEqual(m.finals.map((e) => e.refined), [true, true, false]);
});

test('清書なし（hm_refine_skipped）の速報に印を付ける', () => {
  const m = new TranscriptModel();
  m.apply({ type: 'final', text: 'あ', seg_id: 1 });
  const ch = m.apply({ type: 'hm_refine_skipped', covers: [1] });
  assert.equal(ch.kind, 'marks');
  assert.equal(m.finals[0].refined, 'skipped');
});

test('清書なしの速報は清書タブへ「速報のまま」として移す', () => {
  const m = new TranscriptModel();
  m.apply({ type: 'final', text: 'えっ', seg_id: 7 });
  const ch = m.apply({ type: 'hm_refine_skipped', covers: [7] });
  assert.equal(ch.moved.length, 1);
  assert.equal(m.refined[0].text, 'えっ');
  assert.equal(m.refined[0].skipped, true);
});
