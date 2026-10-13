'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toText, toMarkdown, format, fileStamp } = require('../src/main/transcript');

const entries = [
  { text: 'こんにちは', speaker: 'S1', translations: [{ lang: 'en', text: 'Hello' }] },
  { text: '  ' },
  { text: '<b>太字</b> *強調*' },
];

test('テキスト形式', () => {
  assert.equal(toText(entries), '[S1] こんにちは\n  (→en) Hello\n<b>太字</b> *強調*\n');
});

test('Markdown 形式は特殊文字をエスケープする', () => {
  const md = toMarkdown(entries, { title: 'テスト', date: new Date(2026, 9, 11, 9, 5), source: 'a.mp3' });
  assert.ok(md.startsWith('# テスト\n'));
  assert.ok(md.includes('- 日時: 2026-10-11 09:05'));
  assert.ok(md.includes('**S1**: こんにちは'));
  assert.ok(md.includes('> →en: Hello'));
  assert.ok(md.includes('\\<b\\>太字\\</b\\> \\*強調\\*'));
});

test('JSON 形式は空行を除外する', () => {
  assert.equal(JSON.parse(format(entries, 'json')).length, 2);
});

test('ファイル名用タイムスタンプ', () => {
  assert.equal(fileStamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
});
