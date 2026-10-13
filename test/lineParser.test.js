'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LineSplitter, parseLine, parsePercent, parseFfmpegTime } = require('../src/main/lineParser');

test('LineSplitter はチャンク境界・\\r・\\r\\n をまたいで行に分割する', () => {
  const lines = [];
  const s = new LineSplitter((l) => lines.push(l));
  s.push('abc');
  s.push('def\r\ngh');
  s.push('i\rjk\n');
  s.push(Buffer.from('末尾', 'utf8'));
  s.flush();
  assert.deepEqual(lines, ['abcdef', 'ghi', 'jk', '末尾']);
});

test('イベント行を解析する', () => {
  const r = parseLine('@@HM_EVENT@@{"type":"final","text":"こんにちは"}');
  assert.equal(r.kind, 'event');
  assert.equal(r.event.text, 'こんにちは');
});

test('通常ログ・空行・壊れたイベント', () => {
  assert.equal(parseLine('   '), null);
  assert.deepEqual(parseLine('loading models...'), { kind: 'log', text: 'loading models...' });
  assert.equal(parseLine('@@HM_EVENT@@{broken').kind, 'log');
});

test('進捗率の抽出', () => {
  assert.equal(parsePercent('  model.onnx:  45.3% (10MB/22MB)'), 45.3);
  assert.equal(parsePercent('no percent'), null);
});

test('ffmpeg の時間表記の抽出', () => {
  assert.equal(parseFfmpegTime('  Duration: 00:01:02.50, start: 0', 'duration'), 62.5);
  assert.equal(parseFfmpegTime('size= 1kB time=01:00:10.00 bitrate', 'time'), 3610);
  assert.equal(parseFfmpegTime('nothing', 'time'), null);
});
