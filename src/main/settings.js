'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_RUN_OPTIONS } = require('./args');
const { DEFAULT_PROXY } = require('./proxy');

/**
 * アプリ設定（userData/settings.json）の読み書き。
 */

const DEFAULT_SETTINGS = Object.freeze({
  runtimeRoot: '', // 空なら既定の場所
  modelSet: 'minimal', // minimal（日英 約1.1GB） | full（多言語 約3.1GB）
  autoSaveDir: '', // 空なら自動保存しない
  replaceText: '', // 置換辞書（wrong=right を1行ずつ）
  showTime: true, // 文字起こし結果に時刻を付ける（表示・コピー・保存・自動保存）
  run: { ...DEFAULT_RUN_OPTIONS },
  proxy: { ...DEFAULT_PROXY },
});

class Settings {
  constructor(app) {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // 旧形式（minSilence / maxSpeech / refine を直接指定）→ 既定値から変えていればカスタムとして引き継ぐ
      if (raw.run && raw.run.profile === undefined) {
        const changed = (raw.run.minSilence !== undefined && raw.run.minSilence !== 0.35)
          || (raw.run.maxSpeech !== undefined && raw.run.maxSpeech !== 12) || raw.run.refine === false;
        raw.run.profile = changed ? 'custom' : 'standard';
        raw.run.custom = {
          ...DEFAULT_RUN_OPTIONS.custom,
          ...(raw.run.minSilence !== undefined ? { minSilence: raw.run.minSilence } : {}),
          ...(raw.run.maxSpeech !== undefined ? { maxSpeech: raw.run.maxSpeech } : {}),
          ...(typeof raw.run.refine === 'boolean' ? { refine: raw.run.refine } : {}),
        };
        delete raw.run.minSilence;
        delete raw.run.maxSpeech;
        delete raw.run.refine;
      }
      // 旧形式（input: mic / speaker / mix）→ マイク / PC の音の ON/OFF
      if (raw.run && raw.run.micOn === undefined && raw.run.input) {
        raw.run.micOn = raw.run.input !== 'speaker';
        raw.run.loopbackOn = raw.run.input !== 'mic';
      }
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        run: { ...DEFAULT_RUN_OPTIONS, ...(raw.run || {}) },
        proxy: { ...DEFAULT_PROXY, ...(raw.proxy || {}) },
      };
    } catch {
      return { ...DEFAULT_SETTINGS, run: { ...DEFAULT_RUN_OPTIONS }, proxy: { ...DEFAULT_PROXY } };
    }
  }

  get() {
    return JSON.parse(JSON.stringify(this.data));
  }

  /** 部分更新（run は浅くマージ） */
  update(patch) {
    const next = { ...this.data, ...(patch || {}) };
    if (patch && patch.run) next.run = { ...this.data.run, ...patch.run };
    if (patch && patch.proxy) next.proxy = { ...this.data.proxy, ...patch.proxy };
    this.data = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // 書き込みの途中で落ちても設定ファイルが壊れないよう、一時ファイルに書いてから置き換える
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    return this.get();
  }
}

module.exports = { Settings, DEFAULT_SETTINGS };
