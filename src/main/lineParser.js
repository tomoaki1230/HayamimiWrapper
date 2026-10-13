'use strict';

/**
 * 子プロセスの出力ストリームを行単位に分割し、
 * hayamimi_runner.py が出すイベント行（@@HM_EVENT@@{json}）と通常ログを振り分ける。
 */

const { StringDecoder } = require('string_decoder');

const EVENT_PREFIX = '@@HM_EVENT@@';

class LineSplitter {
  /**
   * @param {(line: string) => void} onLine
   */
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = '';
    // 子プロセスの出力は任意の位置で区切られて届く。日本語（UTF-8 で 3 バイト）の文字の途中で区切られても
    // 化けないよう、まとまりごとに toString せず、文字の途中のバイトを次のまとまりまで持ち越す
    this.decoder = new StringDecoder('utf8');
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    // 末尾の \r は、次のまとまりの先頭が \n（＝ \r\n）かもしれないので持ち越す
    const holdCr = this.buffer.endsWith('\r');
    const text = holdCr ? this.buffer.slice(0, -1) : this.buffer;
    // \r 単独（進捗表示の上書き）も行区切りとして扱う
    const parts = text.split(/\r\n|\n|\r/);
    this.buffer = parts.pop() + (holdCr ? '\r' : '');
    for (const line of parts) this.onLine(line);
  }

  flush() {
    this.buffer += this.decoder.end();
    const rest = this.buffer.replace(/\r$/, '');
    this.buffer = '';
    if (rest) this.onLine(rest);
  }
}

/**
 * 1 行を解析する。
 * @returns {{kind: 'event', event: object} | {kind: 'log', text: string} | null}
 */
function parseLine(line) {
  if (line == null) return null;
  const trimmed = String(line).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(EVENT_PREFIX)) {
    try {
      const event = JSON.parse(trimmed.slice(EVENT_PREFIX.length));
      if (event && typeof event === 'object') return { kind: 'event', event };
    } catch {
      // 壊れたイベントはログとして扱う
    }
  }
  return { kind: 'log', text: trimmed };
}

/** download_models.py の「name: 45.3% (...)」形式から進捗率を取り出す */
function parsePercent(line) {
  const m = /(\d{1,3}(?:\.\d+)?)%/.exec(String(line));
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 100 ? v : null;
}

/** ffmpeg の「Duration: 00:01:02.50」「time=00:00:10.00」を秒へ変換 */
function parseFfmpegTime(line, key) {
  const re = key === 'duration'
    ? /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/
    : /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
  const m = re.exec(String(line));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

module.exports = { LineSplitter, parseLine, parsePercent, parseFfmpegTime, EVENT_PREFIX };
