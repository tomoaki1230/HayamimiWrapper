'use strict';

/**
 * プロキシ設定。
 *
 * - アプリ自身のダウンロード（uv・hayamimi 本体）は Electron の通信機能（Chromium）を使い、
 *   session.setProxy でプロキシを設定する。「OS の設定を使う」では Windows のプロキシ設定・PAC に従う。
 * - uv（Python・ライブラリ）や download_models.py（モデル）は子プロセスのため、
 *   HTTP_PROXY / HTTPS_PROXY / NO_PROXY 環境変数でプロキシを渡す。
 *   「OS の設定を使う」では session.resolveProxy で実際のプロキシを調べて渡す。
 * - 認証が必要なプロキシはユーザー名・パスワードを設定する（パスワードは safeStorage で暗号化して保存）。
 *
 * proxy 設定: { mode: 'system' | 'manual' | 'none', url, bypass, username, passwordEnc }
 */

const DEFAULT_PROXY = Object.freeze({
  mode: 'system',
  url: '', // 例: http://proxy.example.co.jp:8080
  bypass: '', // 例: localhost,127.0.0.1,.example.co.jp
  username: '',
  passwordEnc: '',
});

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const TEST_URLS = ['https://pypi.org/simple/', 'https://github.com/', 'https://huggingface.co/'];

/**
 * 「host:port」や「http://user:pass@host:port」を解釈する。
 * @returns {{server: string, username: string, password: string} | null}
 */
function parseProxyUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h', 'socks4'].includes(scheme)) return null;
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  return {
    server: `${scheme}://${host}${url.port ? `:${url.port}` : ''}`,
    username: decodeURIComponent(url.username || ''),
    password: decodeURIComponent(url.password || ''),
  };
}

/** カンマ・セミコロン・空白区切りの除外リストを配列にする */
function splitBypass(text) {
  return String(text || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** session.setProxy に渡す設定（純粋関数） */
function toSessionConfig(proxy) {
  const p = { ...DEFAULT_PROXY, ...(proxy || {}) };
  if (p.mode === 'none') return { mode: 'direct' };
  if (p.mode === 'manual') {
    const parsed = parseProxyUrl(p.url);
    if (!parsed) return { mode: 'direct' };
    return {
      mode: 'fixed_servers',
      proxyRules: parsed.server,
      proxyBypassRules: ['<local>', ...splitBypass(p.bypass)].join(','),
    };
  }
  return { mode: 'system' };
}

/**
 * session.resolveProxy の結果（PAC 形式）から最初のプロキシを URL として取り出す。
 * 例: "PROXY proxy:8080; DIRECT" → "http://proxy:8080"、"DIRECT" → null
 */
function parsePacResult(result) {
  for (const entry of String(result || '').split(';')) {
    const m = /^\s*(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+(\S+)\s*$/i.exec(entry);
    if (!m) continue;
    const scheme = { PROXY: 'http', HTTPS: 'https', SOCKS5: 'socks5', SOCKS4: 'socks4', SOCKS: 'socks5' }[m[1].toUpperCase()];
    return `${scheme}://${m[2]}`;
  }
  return null;
}

/** 認証情報を URL に埋め込む（子プロセス用） */
function withCredentials(server, username, password) {
  if (!username) return server;
  const url = new URL(server);
  url.username = encodeURIComponent(username);
  if (password) url.password = encodeURIComponent(password);
  return url.toString().replace(/\/$/, '');
}

/**
 * 子プロセスに渡す環境変数の差分を作る（純粋関数）。
 * 値が null のキーは「継承した環境変数から削除する」ことを表す。
 * @param {string|null} server プロキシ（認証情報なし）。null ならプロキシ環境変数を設定しない
 * @param {object} opts
 */
function buildProxyEnv(server, { username = '', password = '', bypass = '', direct = false } = {}) {
  const env = {};
  if (direct) {
    for (const k of PROXY_ENV_KEYS) env[k] = null;
    env.NO_PROXY = '*';
    env.no_proxy = '*';
    return env;
  }
  if (!server) return env;
  const full = withCredentials(server, username, password);
  env.HTTP_PROXY = full;
  env.HTTPS_PROXY = full;
  env.http_proxy = full;
  env.https_proxy = full;
  const noProxy = ['localhost', '127.0.0.1', '::1', ...splitBypass(bypass)].join(',');
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return env;
}

/** 環境変数の差分を適用した新しい env を返す */
function applyEnv(base, diff) {
  const env = { ...base };
  for (const [k, v] of Object.entries(diff || {})) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** 画面表示用に、ログ等へ出すプロキシ URL のパスワードを伏せる */
function maskProxy(url) {
  return String(url || '').replace(/\/\/([^:/@]+):[^@]*@/, '//$1:****@');
}

class ProxyManager {
  /**
   * @param {object} deps
   * @param {() => object} deps.getProxy 現在の proxy 設定を返す
   * @param {Electron.Session} deps.session
   * @param {Electron.SafeStorage} [deps.safeStorage]
   */
  constructor({ getProxy, session, safeStorage }) {
    this.getProxy = getProxy;
    this.session = session;
    this.safeStorage = safeStorage;
  }

  current() {
    return { ...DEFAULT_PROXY, ...(this.getProxy() || {}) };
  }

  /** パスワードを保存用に暗号化する */
  encryptPassword(plain) {
    if (!plain) return '';
    if (this.safeStorage && this.safeStorage.isEncryptionAvailable()) {
      return `enc:${this.safeStorage.encryptString(plain).toString('base64')}`;
    }
    return `b64:${Buffer.from(plain, 'utf8').toString('base64')}`;
  }

  decryptPassword(stored) {
    if (!stored) return '';
    try {
      if (stored.startsWith('enc:') && this.safeStorage) {
        return this.safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
      }
      if (stored.startsWith('b64:')) return Buffer.from(stored.slice(4), 'base64').toString('utf8');
    } catch {
      // 復号できない（別ユーザー・別PCで保存された等）
    }
    return '';
  }

  /** 認証情報（URL 内の指定より、個別に入力したユーザー名・パスワードを優先） */
  credentials() {
    const p = this.current();
    const parsed = p.mode === 'manual' ? parseProxyUrl(p.url) : null;
    const username = p.username || (parsed && parsed.username) || '';
    const password = this.decryptPassword(p.passwordEnc) || (parsed && parsed.password) || '';
    return username ? { username, password } : null;
  }

  /** Electron（Chromium）側のプロキシ設定を反映する */
  async apply() {
    const config = toSessionConfig(this.current());
    await this.session.setProxy(config);
    // 以前の認証情報・接続を使い回さないよう、キャッシュを消してから新しい設定で接続させる
    if (this.session.clearAuthCache) await this.session.clearAuthCache();
    if (this.session.closeAllConnections) await this.session.closeAllConnections();
    return config;
  }

  /** 子プロセス（uv・Python）に渡す環境変数の差分 */
  async childEnvDiff() {
    const p = this.current();
    const creds = this.credentials() || {};
    if (p.mode === 'none') return buildProxyEnv(null, { direct: true });
    if (p.mode === 'manual') {
      const parsed = parseProxyUrl(p.url);
      if (!parsed) return {};
      return buildProxyEnv(parsed.server, { ...creds, bypass: p.bypass });
    }
    // OS の設定: Chromium にプロキシを解決させる（PAC・自動検出を含む）
    let server = null;
    try {
      server = parsePacResult(await this.session.resolveProxy('https://pypi.org/'));
    } catch {
      server = null;
    }
    return buildProxyEnv(server, { ...creds, bypass: p.bypass });
  }

  /** 実際に使われるプロキシの説明（ログ用） */
  async describe() {
    const diff = await this.childEnvDiff();
    if (diff.NO_PROXY === '*') return 'プロキシを使わない';
    if (diff.HTTPS_PROXY) return `プロキシ: ${maskProxy(diff.HTTPS_PROXY)}`;
    return 'プロキシなし（直接接続）';
  }

  /**
   * 接続テスト。各 URL へ実際に接続して結果を返す。
   * @param {(url: string) => Promise<{status: number}>} openUrl
   */
  async test(openUrl) {
    const results = [];
    for (const url of TEST_URLS) {
      const started = Date.now();
      try {
        const res = await openUrl(url);
        if (res.stream && res.stream.destroy) res.stream.destroy();
        results.push({ url, ok: res.status < 400, status: res.status, ms: Date.now() - started });
      } catch (e) {
        results.push({ url, ok: false, error: e.message, ms: Date.now() - started });
      }
    }
    return { via: await this.describe(), results };
  }
}

module.exports = {
  ProxyManager,
  DEFAULT_PROXY,
  parseProxyUrl,
  toSessionConfig,
  parsePacResult,
  buildProxyEnv,
  applyEnv,
  maskProxy,
  splitBypass,
};
