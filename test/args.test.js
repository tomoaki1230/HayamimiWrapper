'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHayamimiArgs } = require('../src/main/args');

test('既定値ではマイク入力・balanced モード', () => {
  assert.deepEqual(buildHayamimiArgs({}), ['--input', 'mic', '--mode', 'balanced', '--threads', '4']);
});

test('日本語固定は --mode single --lang ja', () => {
  const a = buildHayamimiArgs({ langMode: 'ja' });
  assert.ok(a.join(' ').includes('--mode single --lang ja'));
});

test('マイクデバイスは mic/mix のときだけ渡す', () => {
  assert.ok(buildHayamimiArgs({ input: 'mic', micDevice: 'USB' }).includes('--mic-device'));
  assert.ok(!buildHayamimiArgs({ input: 'speaker', micDevice: 'USB' }).includes('--mic-device'));
  const mix = buildHayamimiArgs({ input: 'mix', micDevice: 'USB', speakerDevice: 'Out' });
  assert.ok(mix.includes('--mic-device') && mix.includes('--speaker-device'));
});

test('不正な入力種別はマイクに戻す', () => {
  assert.deepEqual(buildHayamimiArgs({ input: 'evil' }).slice(0, 2), ['--input', 'mic']);
});

test('ファイル文字起こしは --wav と --no-realtime を使い --input を付けない', () => {
  const a = buildHayamimiArgs({ input: 'mic' }, { wavPath: '/tmp/a.wav' });
  assert.deepEqual(a.slice(0, 3), ['--wav', '/tmp/a.wav', '--no-realtime']);
  assert.ok(!a.includes('--input'));
});

test('オプション類の反映', () => {
  const a = buildHayamimiArgs(
    { speakers: true, translate: 'en', partial: false, threads: '6',
      profile: 'custom', custom: { minSilence: 0.5, maxSpeech: 12, refine: false } },
    { replacePath: 'r.txt', transcriptPath: 't.txt' },
  );
  const s = a.join(' ');
  for (const part of ['--speakers', '--translate en', '--no-partial', '--no-refine', '--threads 6',
    '--min-silence 0.5', '--replace r.txt', '--transcript t.txt']) {
    assert.ok(s.includes(part), part);
  }
  assert.ok(!s.includes('--max-speech'), '既定値は渡さない');
});

test('スレッド数は 1 以上の整数', () => {
  assert.ok(buildHayamimiArgs({ threads: 0 }).join(' ').includes('--threads 1'));
  assert.ok(buildHayamimiArgs({ threads: 'abc' }).join(' ').includes('--threads 4'));
});

test('プロファイル: 標準は既定値（引数・環境変数とも追加なし）', () => {
  const { tuningEnv } = require('../src/main/args');
  const a = buildHayamimiArgs({ profile: 'standard' });
  assert.ok(!a.includes('--min-silence') && !a.includes('--max-speech') && !a.includes('--no-refine'));
  assert.deepEqual(tuningEnv({ profile: 'standard' }), { HM_VAD_RESET: '0.3' }, '取りこぼし対策のリセットは既定で有効');
  assert.deepEqual(tuningEnv({ profile: 'custom', custom: { vadReset: 0 } }), {}, '0 なら無効');
});

test('プロファイル: カスタムの値は範囲内に補正され、CLI にない値は環境変数で渡す', () => {
  const { tuningEnv } = require('../src/main/args');
  const opts = { profile: 'custom', custom: { minSilence: 0.8, maxSpeech: 99, vadThreshold: 0.3, beam: 8, blankPenalty: 0.5 } };
  const s = buildHayamimiArgs(opts).join(' ');
  assert.ok(s.includes('--min-silence 0.8'));
  assert.ok(s.includes('--max-speech 60'), '最大長は 60 秒までに補正');
  assert.deepEqual(tuningEnv(opts), { HM_VAD_THRESHOLD: '0.3', HM_BEAM: '8', HM_BLANK_PENALTY: '0.5', HM_VAD_RESET: '0.3' });
});

test('プロファイル: 不明な名前は標準として扱う', () => {
  const { resolveTuning, DEFAULT_TUNING } = require('../src/shared/profiles');
  assert.deepEqual(resolveTuning({ profile: 'unknown' }), { ...DEFAULT_TUNING });
});

test('実行中に反映する設定と、再読み込みが必要な変更の判定', () => {
  const { runtimeConfig, reloadNeeded, parseReplacements } = require('../src/main/args');
  const cfg = runtimeConfig({ profile: 'chat', langMode: 'ja', translate: 'en' }, '汽車=記者\n\nだめ\nはや みみ = hayamimi');
  assert.deepEqual(cfg.vad, { threshold: 0.5, min_silence: 0.7, max_speech: 20 });
  assert.equal(cfg.lang, 'ja');
  assert.deepEqual(cfg.translate, ['en']);
  assert.equal(cfg.vad_reset, 0.3);
  assert.equal(cfg.partial, true);
  assert.equal(runtimeConfig({ partial: false }).partial, false);
  assert.deepEqual(cfg.replacements, { '汽車': '記者', 'はや みみ': 'hayamimi' });
  assert.equal(runtimeConfig({ langMode: 'auto' }).lang, null);
  assert.deepEqual(parseReplacements(''), {});
  assert.deepEqual(reloadNeeded({ speakers: false, threads: 4 }, { speakers: false, threads: 4, profile: 'meeting' }), [], 'プロファイルは即時反映');
  assert.deepEqual(reloadNeeded({ speakers: false, threads: 4 }, { speakers: true, threads: 8 }), ['話者の区別', 'スレッド数']);
  assert.deepEqual(reloadNeeded({}, { profile: 'custom', custom: { refine: false } }), ['清書']);
  assert.deepEqual(reloadNeeded(null, { speakers: true }), []);
});

test('話者の人数: 1〜4 人なら想定話者数を渡し、自動・5 人以上・話者区別 OFF では渡さない', () => {
  const { tuningEnv, runtimeConfig } = require('../src/main/args');
  assert.equal(tuningEnv({ speakers: true, speakerCount: '3' }).HM_MAX_SPEAKERS, '3');
  assert.ok(tuningEnv({ speakers: true, speakerCount: '3' }).HM_SPEAKER_MARGIN);
  assert.ok(tuningEnv({ speakers: true, speakerCount: '3' }).HM_SPEAKER_BOOST, '想定数までは話者を分けやすくする');
  assert.equal(tuningEnv({ speakers: true, speakerCount: 'auto' }).HM_SPEAKER_BOOST, undefined);
  assert.ok(runtimeConfig({ speakers: true, speakerCount: '3' }).speaker_boost > 0);
  assert.equal(tuningEnv({ speakers: true, speakerCount: 'auto' }).HM_MAX_SPEAKERS, undefined);
  assert.equal(tuningEnv({ speakers: true, speakerCount: 'many' }).HM_MAX_SPEAKERS, undefined);
  assert.equal(tuningEnv({ speakers: false, speakerCount: '2' }).HM_MAX_SPEAKERS, undefined);
  assert.equal(runtimeConfig({ speakers: true, speakerCount: '2' }).max_speakers, 2, '途中で人数を変えたら実行中に反映');
  assert.equal(runtimeConfig({ speakers: true, speakerCount: 'auto' }).max_speakers, null);
});
