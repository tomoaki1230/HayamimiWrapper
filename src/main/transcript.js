'use strict';

/**
 * 文字起こし結果をテキスト / Markdown / JSON に整形する純粋関数群。
 *
 * entry: { text, lang?, speaker?, translations?: [{lang, text}], time?: '12:34:56' }
 * time は画面側で作った表示用の時刻ラベル（時刻を付けない設定のときは空）。
 */

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDateTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ファイル名用のタイムスタンプ（例: 20261011-231500） */
function fileStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function cleanEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .map((e) => ({
      text: e.text.trim(),
      lang: e.lang || '',
      speaker: e.speaker || '',
      time: typeof e.time === 'string' ? e.time : '',
      t: e.t ?? null,
      startS: e.startS ?? null,
      translations: Array.isArray(e.translations) ? e.translations.filter((t) => t && t.text) : [],
    }));
}

function toText(entries) {
  return cleanEntries(entries)
    .map((e) => {
      const head = (e.time ? `[${e.time}] ` : '') + (e.speaker ? `[${e.speaker}] ` : '');
      const tr = e.translations.map((t) => `  (→${t.lang}) ${t.text}`);
      return [head + e.text, ...tr].join('\n');
    })
    .join('\n') + '\n';
}

/** Markdown の特殊文字を最低限エスケープ（行頭の記号や HTML タグ扱いを防ぐ） */
function escapeMarkdown(text) {
  return text
    .replace(/([\\`*_{}[\]<>#|])/g, '\\$1')
    // 行頭の箇条書き（- + 1.）・区切り線や見出しの下線（--- ===）として解釈されないようにする
    .replace(/^(\s*)([-+=])/gm, '$1\\$2')
    .replace(/^(\s*\d+)([.)])/gm, '$1\\$2');
}

function toMarkdown(entries, { title = '文字起こし', date = new Date(), source = '' } = {}) {
  const lines = [`# ${escapeMarkdown(title)}`, '', `- 日時: ${formatDateTime(date)}`];
  if (source) lines.push(`- 入力: ${escapeMarkdown(source)}`);
  lines.push('');
  for (const e of cleanEntries(entries)) {
    const head = (e.time ? `\`${e.time}\` ` : '') + (e.speaker ? `**${escapeMarkdown(e.speaker)}**: ` : '');
    lines.push(head + escapeMarkdown(e.text));
    for (const t of e.translations) lines.push(`> →${t.lang}: ${escapeMarkdown(t.text)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function format(entries, kind, meta) {
  switch (kind) {
    case 'md':
      return toMarkdown(entries, meta);
    case 'json':
      return JSON.stringify(cleanEntries(entries), null, 2);
    default:
      return toText(entries);
  }
}

/** 自動保存ファイルへ追記する 1 行（toText と同じ形式） */
function toLine(entry) {
  return toText([entry]);
}

module.exports = { toText, toMarkdown, format, fileStamp, cleanEntries, toLine };
