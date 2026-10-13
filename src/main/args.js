'use strict';

const { resolveTuning, DEFAULT_TUNING } = require('../shared/profiles');

/**
 * 設定オブジェクトから realtime_transcribe.py へ渡すコマンドライン引数を組み立てる。
 * 副作用のない純粋関数（テスト対象）。
 */

const DEFAULT_RUN_OPTIONS = Object.freeze({
  input: 'mic', // mic | speaker | mix（ファイル・旧形式用。リアルタイムは micOn / loopbackOn を使う）
  micOn: true, // リアルタイム: マイクを取り込む
  loopbackOn: false, // リアルタイム: PC の音（スピーカーループバック）を取り込む（Windows のみ）
  micDevice: '',
  speakerDevice: '',
  speakers: false,
  speakerCount: 'auto', // 話者の人数: auto | 1〜4 | many（auto と many は上限なし）
  translate: '', // '' = 翻訳なし, 'en' など
  langMode: 'auto', // auto | ja | en | fast
  threads: 4,
  partial: true,
  profile: 'standard', // 会話の種類（shared/profiles.js）
  custom: { ...DEFAULT_TUNING }, // profile が custom のときの値
});

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {object} opts 実行オプション（DEFAULT_RUN_OPTIONS と同じキー）
 * @param {object} [extra]
 * @param {string} [extra.wavPath] ファイル文字起こし時の WAV パス
 * @param {string} [extra.replacePath] 置換辞書ファイル
 * @param {string} [extra.transcriptPath] 清書テキストの自動保存先（hayamimi 自身に書かせる場合）
 * @param {boolean} [extra.liveGate] リアルタイム（開始待ち付き）。入力は常に --input mic とし、
 *   実際の入力（マイク / PC の音 / 両方）とデバイスはゲートファイルで指定する
 * @returns {string[]}
 */
function buildHayamimiArgs(opts, extra = {}) {
  const o = { ...DEFAULT_RUN_OPTIONS, ...(opts || {}) };
  const args = [];

  if (extra.wavPath) {
    args.push('--wav', extra.wavPath, '--no-realtime');
  } else if (extra.liveGate) {
    args.push('--input', 'mic');
  } else {
    const input = ['mic', 'speaker', 'mix'].includes(o.input) ? o.input : 'mic';
    args.push('--input', input);
    if ((input === 'mic' || input === 'mix') && o.micDevice) {
      args.push('--mic-device', String(o.micDevice));
    }
    if ((input === 'speaker' || input === 'mix') && o.speakerDevice) {
      args.push('--speaker-device', String(o.speakerDevice));
    }
  }

  switch (o.langMode) {
    case 'ja':
    case 'en':
      args.push('--mode', 'single', '--lang', o.langMode);
      break;
    case 'fast':
      args.push('--mode', 'fast');
      break;
    default:
      args.push('--mode', 'balanced');
  }

  const threads = Math.max(1, Math.round(toNumber(o.threads, 4)));
  args.push('--threads', String(threads));

  // 会話の種類（プロファイル）またはカスタム設定の値
  const t = resolveTuning(o);
  if (t.minSilence !== DEFAULT_TUNING.minSilence) args.push('--min-silence', String(t.minSilence));
  if (t.maxSpeech !== DEFAULT_TUNING.maxSpeech) args.push('--max-speech', String(t.maxSpeech));

  if (!o.partial) args.push('--no-partial');
  if (!t.refine) args.push('--no-refine');
  if (o.speakers) args.push('--speakers');
  if (o.translate) args.push('--translate', String(o.translate));

  if (extra.replacePath) args.push('--replace', extra.replacePath);
  if (extra.transcriptPath) args.push('--transcript', extra.transcriptPath);

  return args;
}

/**
 * リアルタイムの入力設定（マイク / PC の音の ON/OFF とデバイス）をゲートファイルの中身に変換する。
 * どちらも OFF なら null（取り込まない）。PC の音は Windows のみ。
 */
function captureConfig(opts, platform = process.platform) {
  const o = { ...DEFAULT_RUN_OPTIONS, ...(opts || {}) };
  const mic = !!o.micOn;
  const loopback = !!o.loopbackOn && platform === 'win32';
  if (!mic && !loopback) return null;
  return {
    source: mic && loopback ? 'mix' : (loopback ? 'speaker' : 'mic'),
    micDevice: mic ? String(o.micDevice || '') : '',
    speakerDevice: loopback ? String(o.speakerDevice || '') : '',
  };
}

// 想定話者数に達した後、既存話者と一致とみなす基準を緩める幅（途中参加の人は検出できる「やわらかい上限」）。評価結果で決定
const SPEAKER_MARGIN = 0.1;
// 想定話者数に達するまで、一致とみなす基準を上げて新しい話者に分けやすくする幅（hayamimi は声の似た人をまとめ、人数を少なく見積もりがちなため）。
const SPEAKER_BOOST = 0.1;

/** 話者の人数の設定 → 想定話者数（上限をかけないときは null） */
function speakerLimit(o) {
  if (!o.speakers) return null;
  const n = Number(o.speakerCount);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : null;
}

/**
 * CLI に無い設定（発話検出のしきい値・探索の幅・無音判定の補正）を、ラッパーへ渡す環境変数にする。
 * 既定値と同じものは渡さない。
 */
function tuningEnv(opts) {
  const t = resolveTuning({ ...DEFAULT_RUN_OPTIONS, ...(opts || {}) });
  const env = {};
  if (t.vadThreshold !== DEFAULT_TUNING.vadThreshold) env.HM_VAD_THRESHOLD = String(t.vadThreshold);
  if (t.beam !== DEFAULT_TUNING.beam) env.HM_BEAM = String(t.beam);
  if (t.blankPenalty !== DEFAULT_TUNING.blankPenalty) env.HM_BLANK_PENALTY = String(t.blankPenalty);
  // 発話検出のリセットはこのアプリの対策（hayamimi の既定には無い）なので、有効なら常に渡す
  if (t.vadReset > 0) env.HM_VAD_RESET = String(t.vadReset);
  const limit = speakerLimit({ ...DEFAULT_RUN_OPTIONS, ...(opts || {}) });
  if (limit) {
    env.HM_MAX_SPEAKERS = String(limit);
    env.HM_SPEAKER_MARGIN = String(SPEAKER_MARGIN);
    env.HM_SPEAKER_BOOST = String(SPEAKER_BOOST);
  }
  return env;
}

/** 置換辞書のテキスト（間違い=正しい を 1 行ずつ）を対応表にする */
function parseReplacements(text) {
  const map = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) {
      const wrong = line.slice(0, i).trim();
      if (wrong) map[wrong] = line.slice(i + 1).trim();
    }
  }
  return map;
}

/** モデルを読み込んだまま反映できる設定（ラッパーの設定ファイルの中身） */
function runtimeConfig(opts, replaceText) {
  const o = { ...DEFAULT_RUN_OPTIONS, ...(opts || {}) };
  const t = resolveTuning(o);
  return {
    vad: { threshold: t.vadThreshold, min_silence: t.minSilence, max_speech: t.maxSpeech },
    lang: o.langMode === 'ja' || o.langMode === 'en' ? o.langMode : null,
    replacements: parseReplacements(replaceText),
    decoder: { beam: t.beam, blank_penalty: t.blankPenalty },
    vad_reset: t.vadReset > 0 ? t.vadReset : null,
    partial: o.partial !== false,
    max_speakers: speakerLimit(o),
    speaker_margin: SPEAKER_MARGIN,
    speaker_boost: SPEAKER_BOOST,
    translate: o.translate ? [String(o.translate)] : [],
  };
}

/** 読み込み時の設定と比べ、再読み込みしないと反映されない変更の一覧（画面表示用の名前） */
function reloadNeeded(loaded, current) {
  if (!loaded) return [];
  const a = { ...DEFAULT_RUN_OPTIONS, ...loaded };
  const b = { ...DEFAULT_RUN_OPTIONS, ...current };
  const items = [];
  if (!!a.speakers !== !!b.speakers) items.push('話者の区別');
  if (resolveTuning(a).refine !== resolveTuning(b).refine) items.push('清書');
  if (Number(a.threads) !== Number(b.threads)) items.push('スレッド数');
  if (a.langMode !== b.langMode && (a.langMode === 'fast' || b.langMode === 'fast')) items.push('言語の切り替え方式');
  return items;
}

module.exports = {
  buildHayamimiArgs, captureConfig, tuningEnv, runtimeConfig, reloadNeeded, parseReplacements, DEFAULT_RUN_OPTIONS,
};
