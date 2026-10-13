'use strict';

// 既存テスト（正常系の機能確認）とは別の観点: 壊れた入力・境界値・大量データ・設定ファイルの破損に対する頑健性

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LineSplitter, parseLine } = require('../src/main/lineParser');
const { TranscriptModel } = require('../src/renderer/transcriptView');
const { RefineLagTracker } = require('../src/renderer/refineChart');
const transcript = require('../src/main/transcript');
const { buildHayamimiArgs, tuningEnv, runtimeConfig, captureConfig, parseReplacements } = require('../src/main/args');
const { Settings, DEFAULT_SETTINGS } = require('../src/main/settings');

/** 再現できる乱数（失敗したときに同じ入力で調べられるように） */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('出力がどこで途切れても（UTF-8 の文字の途中でも）同じ行・同じイベントに復元できる', () => {
  const events = [];
  for (let i = 0; i < 200; i++) {
    events.push(`@@HM_EVENT@@${JSON.stringify({ type: 'final', text: `第${i}発言：日本語と絵文字🎙と記号「」`, seg_id: i })}`);
    events.push(`[ja/rz] ログ行 ${i}（seg=1.0s）`);
  }
  const whole = Buffer.from(`${events.join('\r\n')}\n`, 'utf8');
  const expected = [];
  new LineSplitter((l) => expected.push(l)).push(whole);
  const r = rng(42);
  for (let trial = 0; trial < 30; trial++) {
    const got = [];
    const s = new LineSplitter((l) => got.push(l));
    for (let pos = 0; pos < whole.length;) {
      const n = 1 + Math.floor(r() * 40); // 1〜40 バイトずつ（多バイト文字の途中で切れる）
      s.push(whole.subarray(pos, pos + n));
      pos += n;
    }
    s.flush();
    assert.deepEqual(got, expected, `試行 ${trial}`);
  }
  const parsed = expected.map(parseLine).filter((p) => p && p.kind === 'event');
  assert.equal(parsed.length, 200);
  assert.equal(parsed[199].event.text, '第199発言：日本語と絵文字🎙と記号「」');
});

test('でたらめな出力行で例外を出さない（壊れた JSON・巨大な行・制御文字・JSON 以外の値）', () => {
  const r = rng(7);
  const samples = ['@@HM_EVENT@@', '@@HM_EVENT@@null', '@@HM_EVENT@@123', '@@HM_EVENT@@"文字列"', '@@HM_EVENT@@[1,2]',
    '@@HM_EVENT@@{"type":', `@@HM_EVENT@@${'{'.repeat(10000)}`, '\u0000\u0007\u001b[31m赤\u001b[0m', 'x'.repeat(2_000_000)];
  for (let i = 0; i < 500; i++) {
    samples.push(Array.from({ length: Math.floor(r() * 80) }, () => String.fromCharCode(Math.floor(r() * 0x3000))).join(''));
  }
  for (const line of samples) {
    const p = parseLine(line);
    assert.ok(p === null || p.kind === 'log' || (p.kind === 'event' && typeof p.event === 'object' && p.event !== null),
      `想定外の解析結果: ${line.slice(0, 40)}`);
  }
});

test('壊れた・想定外のイベントを受けても結果の状態が壊れない', () => {
  const m = new TranscriptModel();
  const weird = [null, undefined, 0, 'final', [], { type: 'final' }, { type: 'final', text: 123 }, { type: 'final', text: '   ' },
    { type: 'refine', text: '清書', covers: 'abc' }, { type: 'refine', text: '清書', covers: [null, {}, -1, 1e12] },
    { type: 'hm_refine_skipped', covers: null }, { type: 'hm_refine_skipped' }, { type: 'translation', text: '先に翻訳だけ' },
    { type: 'partial', text: null }, { type: 'final', text: '<img src=x onerror=alert(1)>', seg_id: '1' },
    { type: 'final', text: 'x'.repeat(100000), seg_id: 2 }, { type: 'refine', text: '後', covers: [2, 2, 2] }, { type: '__proto__' }];
  for (const e of weird) assert.doesNotThrow(() => m.apply(e), JSON.stringify(e)?.slice(0, 60));
  assert.ok(Array.isArray(m.finals) && Array.isArray(m.refined));
  assert.ok(m.finals.every((f) => typeof f.text === 'string' && f.text.trim()));
  assert.equal(m.finals.find((f) => f.segId === 2).refined, true, '重複した covers でも 1 回だけ清書済みにする');
  assert.equal(m.refined.filter((e) => e.text === '後').length, 1);
  assert.doesNotThrow(() => m.toPlainText('finals', true));
});

test('3 時間の会議に相当する件数（速報 6000・清書 2000）でも処理が線形に近い時間で終わる', () => {
  const m = new TranscriptModel();
  const tr = new RefineLagTracker();
  const t0 = process.hrtime.bigint();
  let seg = 0;
  for (let i = 0; i < 2000; i++) {
    const covers = [];
    for (let k = 0; k < 3; k++) {
      seg++;
      m.apply({ type: 'final', text: `発言 ${seg} です。`, lang: 'ja', seg_id: seg, t: 1e9 + seg * 1.8 });
      tr.onFinal(seg, seg * 1800);
      covers.push(seg);
    }
    m.apply({ type: 'refine', text: `清書 ${i}`, lang: 'ja', covers, t: 1e9 + seg * 1.8 });
    tr.onRefine(covers, seg * 1800 + 4000);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(m.finals.length, 6000);
  assert.equal(m.refined.length, 2000);
  assert.equal(m.finals.filter((f) => !f.refined).length, 0);
  // 清書ごとに速報全体を走査しているため O(n²) になりうる。実用上の上限として 3 秒以内を求める
  assert.ok(ms < 3000, `処理時間 ${ms.toFixed(0)}ms`);
  const text = m.toPlainText('refined', true);
  assert.equal(text.split('\n').length, 2000);
});

test('保存形式は悪意のある文字列でも構造を壊さない（Markdown の記号・改行・HTML）', () => {
  const nasty = ['# 見出し', '*強調*', '[リンク](javascript:alert(1))', '<script>alert(1)</script>', '`コード`', '| 表 |', '1. 番号',
    '行1\n# 行2', '> 引用', '---', '\\', '<!-- コメント', '![画像](http://x/y.png)', '- 箇条書き', '+ 項目', '2) 番号', '行A\n===', '行B\n---'];
  const entries = nasty.map((text, i) => ({ text, speaker: i % 2 ? 'S1' : '', time: '12:00:00', translations: [{ lang: 'en', text: '<b>t</b>' }] }));
  const md = transcript.format(entries, 'md', { date: new Date(2026, 9, 12) });
  assert.ok(!/<script>/i.test(md), 'script タグがそのまま残らない');
  assert.ok(!/^# 見出し/m.test(md), '本文が見出しにならない');
  assert.ok(!/(^|[^\\])\]\(javascript:/im.test(md), 'リンク記法として解釈されない（] が打ち消されている）');
  assert.ok(!/^(-{3,}|={3,})\s*$/m.test(md), '区切り線・見出しの下線にならない');
  assert.ok(!/^\s*([-+]|\d+[.)]) /m.test(md.split('\n').slice(3).join('\n')), '箇条書きにならない');
  const json = JSON.parse(transcript.format(entries, 'json', { date: new Date() }));
  assert.ok(Array.isArray(json.entries) ? json.entries.length === nasty.length : true);
  const txt = transcript.format(entries, 'txt', {});
  assert.ok(txt.includes('<script>alert(1)</script>'), 'テキスト形式は内容をそのまま残す');
  assert.doesNotThrow(() => transcript.format(null, 'md', {}));
  assert.doesNotThrow(() => transcript.format([null, 1, 'a', { text: null }], 'txt', {}));
});

test('極端・不正な設定値でも引数と設定ファイルの内容が安全な範囲に収まる', () => {
  const weird = [
    {}, null, undefined, { threads: -5 }, { threads: 'abc' }, { threads: 1e9 }, { threads: 2.7 },
    { langMode: '"; rm -rf /' }, { input: '../../etc' }, { micDevice: '--wav /etc/passwd' }, { translate: '--help' },
    { profile: 'custom', custom: { minSilence: -1, maxSpeech: 1e9, vadThreshold: 5, beam: -3, blankPenalty: 'x', vadReset: NaN, refine: 'no' } },
    { profile: '__proto__' }, { speakers: true, speakerCount: '1e3' }, { speakers: true, speakerCount: -2 }, { partial: 'false' },
  ];
  for (const o of weird) {
    const args = buildHayamimiArgs(o || {}, { transcriptPath: null });
    assert.ok(Array.isArray(args) && args.every((a) => typeof a === 'string'), JSON.stringify(o));
    const ti = args.indexOf('--threads');
    if (ti >= 0) assert.ok(/^[1-9]\d*$/.test(args[ti + 1]), `スレッド数: ${args[ti + 1]}`);
    // デバイス名などは「値」として 1 つの引数で渡り、別のオプションとして解釈されない
    const mi = args.indexOf('--mic-device');
    if (mi >= 0) assert.equal(args[mi + 1], (o || {}).micDevice);
    const env = tuningEnv(o || {});
    for (const [k, v] of Object.entries(env)) {
      assert.ok(/^HM_[A-Z_]+$/.test(k) && Number.isFinite(Number(v)), `${k}=${v}`);
    }
    const cfg = runtimeConfig(o || {}, '');
    assert.ok(cfg.vad.min_silence > 0 && cfg.vad.max_speech > 0 && cfg.vad.threshold > 0 && cfg.vad.threshold <= 1, JSON.stringify(cfg.vad));
    assert.ok(cfg.max_speakers === null || (Number.isInteger(cfg.max_speakers) && cfg.max_speakers >= 1 && cfg.max_speakers <= 4));
    const cap = captureConfig(o || {}, 'win32');
    assert.ok(['mic', 'speaker', 'mix'].includes(cap.source));
  }
});

test('置換辞書は壊れた行・巨大な入力・特殊なキーでも落ちず、プロトタイプを汚さない', () => {
  const text = ['=空', '正しい行=正', '==', 'a=b=c', '  前後空白  =  値  ', '__proto__=汚染', 'constructor=x', '\u0000=nul', 'x'.repeat(100000) + '=長い']
    .join('\r\n');
  const map = parseReplacements(text);
  assert.equal(map['正しい行'], '正');
  assert.equal(map.a, 'b=c');
  assert.equal(map['前後空白'], '値');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype['汚染'], undefined);
  assert.doesNotThrow(() => JSON.stringify(map));
});

test('設定ファイルが壊れていても既定値で起動でき、保存すると正しい JSON に戻る', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hm3-settings-'));
  const app = { getPath: () => dir };
  const file = path.join(dir, 'settings.json');
  const cases = ['', '{', 'null', '[]', '"文字列"', '{"run": null, "proxy": 5}', '\uFEFF{"autoSaveDir": "C:\\\\保存"}', Buffer.from([0xff, 0xfe, 0x00])];
  for (const body of cases) {
    fs.writeFileSync(file, body);
    let s;
    assert.doesNotThrow(() => { s = new Settings(app); }, String(body).slice(0, 20));
    const d = s.get();
    assert.equal(typeof d.run, 'object');
    assert.equal(typeof d.proxy, 'object');
    assert.ok(d.run && d.run.profile !== undefined, '実行オプションの既定値がそろう');
    s.update({ replaceText: 'a=b' });
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(back.replaceText, 'a=b');
  }
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS).sort(), Object.keys(new Settings(app).get()).filter((k) => k in DEFAULT_SETTINGS).sort());
  fs.rmSync(dir, { recursive: true, force: true });
});
