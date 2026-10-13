'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ProxyManager, parseProxyUrl, toSessionConfig, parsePacResult, buildProxyEnv, applyEnv, maskProxy,
} = require('../src/main/proxy');

test('プロキシ URL の解釈', () => {
  assert.deepEqual(parseProxyUrl('proxy.local:8080'), { server: 'http://proxy.local:8080', username: '', password: '' });
  assert.deepEqual(parseProxyUrl('http://u%40x:p%3Ass@proxy:3128'),
    { server: 'http://proxy:3128', username: 'u@x', password: 'p:ss' });
  assert.equal(parseProxyUrl('socks5://s:1080').server, 'socks5://s:1080');
  assert.equal(parseProxyUrl(''), null);
  assert.equal(parseProxyUrl('ftp://x:21'), null);
});

test('Electron の session 設定', () => {
  assert.deepEqual(toSessionConfig({ mode: 'system' }), { mode: 'system' });
  assert.deepEqual(toSessionConfig({ mode: 'none' }), { mode: 'direct' });
  assert.deepEqual(toSessionConfig({ mode: 'manual', url: 'http://a:b@p:8080', bypass: '.corp.jp; 10.0.0.1' }), {
    mode: 'fixed_servers', proxyRules: 'http://p:8080', proxyBypassRules: '<local>,.corp.jp,10.0.0.1',
  });
  assert.deepEqual(toSessionConfig({ mode: 'manual', url: '' }), { mode: 'direct' });
});

test('PAC 形式の解決結果', () => {
  assert.equal(parsePacResult('PROXY proxy:8080; DIRECT'), 'http://proxy:8080');
  assert.equal(parsePacResult('HTTPS sp:443'), 'https://sp:443');
  assert.equal(parsePacResult('SOCKS5 s:1080'), 'socks5://s:1080');
  assert.equal(parsePacResult('DIRECT'), null);
});

test('子プロセス用の環境変数', () => {
  const env = buildProxyEnv('http://p:8080', { username: 'user', password: 'p@ss:w', bypass: '.corp.jp' });
  assert.equal(env.HTTPS_PROXY, 'http://user:p%40ss%3Aw@p:8080');
  assert.equal(env.http_proxy, env.HTTPS_PROXY);
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1,.corp.jp');
  const direct = buildProxyEnv(null, { direct: true });
  assert.equal(direct.HTTPS_PROXY, null);
  assert.equal(direct.NO_PROXY, '*');
  assert.deepEqual(buildProxyEnv(null), {});
  const applied = applyEnv({ HTTPS_PROXY: 'old', PATH: '/bin' }, direct);
  assert.ok(!('HTTPS_PROXY' in applied));
  assert.equal(applied.PATH, '/bin');
});

test('パスワードを伏せる', () => {
  assert.equal(maskProxy('http://user:secret@p:8080'), 'http://user:****@p:8080');
  assert.equal(maskProxy('http://p:8080'), 'http://p:8080');
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`X${s}`, 'utf8'),
    decryptString: (b) => b.toString('utf8').slice(1),
  };
}

test('ProxyManager: 認証情報と環境変数（OS 設定は resolveProxy で解決）', async () => {
  let proxy = { mode: 'system', username: 'taro' };
  const pm = new ProxyManager({
    getProxy: () => proxy,
    session: { resolveProxy: async () => 'PROXY corp:8080', setProxy: async () => {} },
    safeStorage: fakeSafeStorage(),
  });
  proxy.passwordEnc = pm.encryptPassword('pw');
  assert.ok(proxy.passwordEnc.startsWith('enc:'));
  assert.deepEqual(pm.credentials(), { username: 'taro', password: 'pw' });
  const env = await pm.childEnvDiff();
  assert.equal(env.HTTPS_PROXY, 'http://taro:pw@corp:8080');
  assert.equal(await pm.describe(), 'プロキシ: http://taro:****@corp:8080');

  proxy = { mode: 'manual', url: 'http://u:v@m:3128' };
  assert.deepEqual(pm.credentials(), { username: 'u', password: 'v' }, 'URL 内の認証情報も使える');
  assert.equal((await pm.childEnvDiff()).HTTP_PROXY, 'http://u:v@m:3128');

  proxy = { mode: 'none' };
  assert.equal((await pm.childEnvDiff()).NO_PROXY, '*');
});
