'use strict';

const { spawn } = require('child_process');
const { LineSplitter } = require('./lineParser');

/**
 * 子プロセスを起動し、標準出力・標準エラーを行単位でコールバックに渡す。
 * 終了コード 0 で resolve、それ以外は reject する。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [options]
 * @param {(line: string, stream: 'stdout'|'stderr') => void} [options.onLine]
 * @param {(child: import('child_process').ChildProcess) => void} [options.onSpawn]
 */
function run(cmd, args, options = {}) {
  const { onLine = () => {}, onSpawn, ...spawnOpts } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, ...spawnOpts });
    } catch (err) {
      reject(err);
      return;
    }
    if (onSpawn) onSpawn(child);
    const out = new LineSplitter((l) => onLine(l, 'stdout'));
    const errS = new LineSplitter((l) => onLine(l, 'stderr'));
    const tail = [];
    const remember = (l) => {
      if (!l.trim()) return;
      tail.push(l);
      if (tail.length > 30) tail.shift();
    };
    child.stdout && child.stdout.on('data', (d) => out.push(d));
    child.stderr && child.stderr.on('data', (d) => {
      errS.push(d);
      d.toString('utf8').split(/\r?\n|\r/).forEach(remember);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      out.flush();
      errS.flush();
      if (code === 0) resolve();
      else {
        const err = new Error(`${cmd} が終了コード ${code ?? signal} で終了しました`);
        err.tail = tail.join('\n');
        reject(err);
      }
    });
  });
}

module.exports = { run };
