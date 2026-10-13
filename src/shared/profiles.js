/*
 * 認識プロファイル（会話の種類ごとの設定値）。main・renderer 共通（UMD）。
 *
 * 値の意味:
 *   minSilence   区切りとみなす無音（秒）       --min-silence
 *   maxSpeech    1 発話の最大長（秒）           --max-speech
 *   vadThreshold 発話検出のしきい値（0〜1。小さいほど小さな声も拾うが雑音も拾いやすい）  HM_VAD_THRESHOLD
 *   beam         探索の幅（日本語の認識。大きいほど候補を多く比べるが遅くなる）          HM_BEAM
 *   blankPenalty 無音判定の補正（大きいほど文字の取りこぼしが減るが、余計な文字が増えやすい） HM_BLANK_PENALTY
 *   vadReset     発話検出のリセット（秒。発言後この長さの無音で検出器を作り直す。0 で無効）  HM_VAD_RESET
 *                大きな声の直後の小さな声の取りこぼしを防ぐ（hayamimi 自体には無い、このアプリの対策。既定で有効）
 *   refine       清書（2 回目の高精度認識）を行う  --no-refine
 *
 * 各プロファイルの値は、5 つの日本語音声データ（FLEURS・ReazonSpeech・Common Voice）で会話の種類を模したテスト音声を作り、
 * 文字誤り率を測って決めた。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HMProfiles = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 既定値（hayamimi の既定値＋このアプリの取りこぼし対策 vadReset） */
  const DEFAULT_TUNING = Object.freeze({
    minSilence: 0.35,
    maxSpeech: 12,
    vadThreshold: 0.5,
    vadReset: 0.3,
    beam: 4,
    blankPenalty: 0,
    refine: true,
  });

  /** 値の範囲（カスタム設定の入力欄・値の補正に使う） */
  const RANGES = Object.freeze({
    minSilence: { min: 0.1, max: 3, step: 0.05, unit: '秒', label: '区切りとみなす無音',
      help: '短いほど早く確定しますが、考えながら話すときの「間」で文が途中で切れやすくなります。' },
    maxSpeech: { min: 3, max: 60, step: 1, unit: '秒', label: '1 発話の最大長',
      help: '切れ目なく話し続けたとき、この長さで強制的に区切ります。短すぎると文の途中で切れて精度が下がります。' },
    vadThreshold: { min: 0.05, max: 0.95, step: 0.05, unit: '', label: '発話検出のしきい値',
      help: '小さいほど小さな声も拾います（声の小さい参加者がいる会議など）。下げすぎると雑音も文字にしやすくなります。' },
    vadReset: { min: 0, max: 3, step: 0.1, unit: '秒', label: '発話検出のリセット',
      help: '発言のあと、この長さの無音で発話検出をリセットし、大きな声の直後の小さな声の取りこぼしを防ぎます。0 で無効。' },
    beam: { min: 1, max: 16, step: 1, unit: '', label: '探索の幅',
      help: '大きいほど多くの候補を比べます（日本語の認識）。処理は重くなります。' },
    blankPenalty: { min: 0, max: 3, step: 0.1, unit: '', label: '無音判定の補正',
      help: '大きくすると文字の取りこぼしが減りますが、余計な文字が増えやすくなります。' },
  });

  // 値は 5 つのデータ（FLEURS 3・放送・Common Voice）で「平均で改善し、どのデータでも 1 ポイント以上悪化しない」ものだけを採用した。
  // 講演・会議・インタビューは、検証の結果どの候補も条件を満たさず、標準と同じ値が最も安定していた。
  const PROFILES = Object.freeze([
    { id: 'standard', label: '標準', description: 'hayamimi の既定値に、取りこぼし対策（発話検出のリセット）を加えた設定です。迷ったらこれを選んでください。',
      tuning: { ...DEFAULT_TUNING } },
    { id: 'lecture', label: '講演・プレゼン', description: '1 人が話し続ける場面向けです。検証の結果、標準と同じ設定が最も安定していました。',
      tuning: { ...DEFAULT_TUNING } },
    { id: 'meeting', label: '会議', description: '複数人が交互に話す場面向けです。検証の結果、標準と同じ設定が最も安定していました（声の小さい参加者の取りこぼし対策は有効です）。',
      tuning: { ...DEFAULT_TUNING } },
    { id: 'chat', label: '雑談・テンポの速い会話', description: '発言の間がとても短い会話向けです。前後の発言をまとめて認識しやすくします（速報は少し遅れて出ます）。',
      tuning: { ...DEFAULT_TUNING, minSilence: 0.7, maxSpeech: 20 } },
    { id: 'interview', label: 'インタビュー・考えながら話す', description: '文の途中に「間」がある場面向けです。検証の結果、標準と同じ設定が最も安定していました。',
      tuning: { ...DEFAULT_TUNING } },
    { id: 'reading', label: '朗読・原稿読み上げ', description: '原稿を切れ目なく読み上げる場面向けです。短めに区切って認識します。',
      tuning: { ...DEFAULT_TUNING, minSilence: 0.2, maxSpeech: 9 } },
    { id: 'custom', label: 'カスタム', description: 'すべての値を自分で設定します。' },
  ]);

  function clamp(v, r) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.min(r.max, Math.max(r.min, n));
  }

  /** 値を範囲内に補正する（不正な値は既定値） */
  function sanitizeTuning(t) {
    const out = { ...DEFAULT_TUNING };
    for (const [k, r] of Object.entries(RANGES)) {
      const v = clamp(t && t[k], r);
      if (v !== null) out[k] = k === 'beam' || k === 'maxSpeech' ? Math.round(v) : v;
    }
    if (t && typeof t.refine === 'boolean') out.refine = t.refine;
    return out;
  }

  function getProfile(id) {
    return PROFILES.find((p) => p.id === id) || PROFILES[0];
  }

  /**
   * 実行オプションから、実際に使う値を決める。
   * @param {{profile?: string, custom?: object}} run
   */
  function resolveTuning(run) {
    const id = run && run.profile;
    if (id === 'custom') return sanitizeTuning(run.custom);
    return { ...getProfile(id).tuning };
  }

  return { DEFAULT_TUNING, RANGES, PROFILES, sanitizeTuning, resolveTuning, getProfile };
});
