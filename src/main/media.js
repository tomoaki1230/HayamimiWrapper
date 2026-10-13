'use strict';

const fs = require('fs');
const path = require('path');
const { run } = require('./proc');
const { parseFfmpegTime } = require('./lineParser');

/**
 * 音声・動画ファイルを hayamimi が読める 16kHz モノラル 16bit WAV に変換する。
 * ffmpeg はアプリに同梱（ffmpeg-static）しているため、ユーザーの導入は不要。
 */

function ffmpegPath() {
  let p = require('ffmpeg-static');
  if (!p) throw new Error('この環境向けの ffmpeg が同梱されていません');
  // パッケージ後は asar 外（app.asar.unpacked）に展開された実行ファイルを使う
  p = p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return p;
}

const MEDIA_EXTENSIONS = [
  'wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'webm',
  'mp4', 'mov', 'mkv', 'avi', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts',
];

/**
 * @param {string} input 入力ファイル
 * @param {string} outDir 出力先ディレクトリ
 * @param {(fraction: number) => void} [onProgress]
 * @param {(child) => void} [onSpawn]
 * @returns {Promise<{wavPath: string, duration: number|null}>}
 */
async function convertToWav(input, outDir, onProgress, onSpawn) {
  if (!fs.existsSync(input)) throw new Error(`ファイルが見つかりません: ${input}`);
  fs.mkdirSync(outDir, { recursive: true });
  const wavPath = path.join(outDir, `input-${Date.now()}.wav`);
  let duration = null;
  try {
    await run(ffmpegPath(), [
      '-hide_banner', '-nostdin', '-y', '-i', input,
      '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-f', 'wav', wavPath,
    ], {
      onSpawn,
      onLine: (line) => {
        if (duration == null) duration = parseFfmpegTime(line, 'duration');
        const t = parseFfmpegTime(line, 'time');
        if (t != null && duration && onProgress) onProgress(Math.min(1, t / duration));
      },
    });
  } catch (err) {
    // 途中まで書かれた変換ファイルを残さない（変換の失敗・中止）
    fs.rmSync(wavPath, { force: true });
    const friendly = new Error(explainFfmpegError(err));
    friendly.tail = err.tail; // 詳しい出力はログ用に残す
    throw friendly;
  }
  return { wavPath, duration };
}

/** ffmpeg の失敗を、利用者に分かる言葉にする（詳しい出力は err.tail としてログに出す） */
function explainFfmpegError(err) {
  const tail = String((err && err.tail) || '');
  if (/does not contain any stream|matches no streams|no audio|Stream map .* matches no streams/i.test(tail)) {
    return 'このファイルには音声が含まれていません（映像だけの動画など）。音声の入ったファイルを選んでください。';
  }
  if (/Invalid data found|Error opening input|could not find codec|Header missing|moov atom not found|End of file/i.test(tail)) {
    return '音声・動画ファイルとして読み込めませんでした。ファイルが壊れているか、対応していない形式です。';
  }
  if (/Permission denied/i.test(tail)) return 'ファイルを読み込む権限がありません。';
  if (/No space left/i.test(tail)) return 'ディスクの空き容量が足りないため、変換できませんでした。';
  return `ファイルを変換できませんでした（${(err && err.message) || 'ffmpeg のエラー'}）。詳しくは「ログ」画面を確認してください。`;
}

module.exports = { convertToWav, ffmpegPath, explainFfmpegError, MEDIA_EXTENSIONS };
