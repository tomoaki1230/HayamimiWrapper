/*
 * 文字起こし結果の時刻表記（画面・保存・自動保存で共通）。
 * - リアルタイム: 実時刻（t: UNIX 秒）→「HH:MM:SS」
 * - ファイル    : ファイル先頭からの経過（startS: 秒）→「M:SS」または「H:MM:SS」
 *
 * ブラウザでは window.HMTime、Node.js では module.exports として使う。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HMTime = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');

  /** 実時刻（ミリ秒）→ HH:MM:SS（ローカル時刻） */
  function formatClock(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** 経過秒 → M:SS / H:MM:SS */
  function formatOffset(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  /**
   * エントリーの時刻ラベル。t（実時刻）を優先し、なければ startS（経過時間）。どちらもなければ ''。
   * @param {{t?: number|null, startS?: number|null}} entry
   */
  function timeLabel(entry) {
    if (!entry) return '';
    if (entry.t != null && Number.isFinite(Number(entry.t))) return formatClock(Number(entry.t) * 1000);
    if (entry.startS != null && Number.isFinite(Number(entry.startS))) return formatOffset(entry.startS);
    return '';
  }

  return { formatClock, formatOffset, timeLabel };
});
