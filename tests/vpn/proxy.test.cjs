'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const base = process.env.VPN_EXTENSION_ROOT || path.resolve(__dirname, '../../extension');
const C = require(path.join(base, 'lib/core.js'));
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function pac(c = {}) {
  const cfg = C.config({ ...c, enabled: true, mode: 'pac' });
  const context = {}; vm.createContext(context); vm.runInContext(C.buildPacScript(cfg), context);
  return host => context.FindProxyForURL('https://' + host, host);
}
function worker() {
  const data = {}, events = {}, calls = [], state = { setting: { value: { mode: 'system' }, levelOfControl: 'controllable_by_this_extension' }, failStorage: false, failProxy: false, failRollback: false, fetchCount: 0, sets: [] };
  const event = name => ({ addListener: fn => { events[name] = fn; } });
  const chrome = {
    runtime: { id: 'fixture', onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed') },
    storage: { local: {
      get: async keys => { const out = {}; for (const key of typeof keys === 'string' ? [keys] : keys) out[key] = copy(data[key]); return out; },
      set: async values => { if (state.failStorage) { state.failStorage = false; throw Error('fixture storage failure'); } state.sets.push(Object.keys(values)); Object.assign(data, copy(values)); }
    } },
    action: { setBadgeText: async value => { state.badge = value.text; }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    proxy: { onProxyError: event('proxyError'), settings: {
      get: async () => copy(state.setting),
      set: async ({ value }) => { calls.push(copy(value)); if (state.failProxy) { state.failProxy = false; throw Error('fixture apply failure'); } state.setting = { value: copy(value), levelOfControl: 'controlled_by_this_extension' }; },
      clear: async () => { calls.push(null); if (state.failRollback) throw Error('fixture rollback failure'); state.setting = { value: { mode: 'system' }, levelOfControl: 'controllable_by_this_extension' }; },
      onChange: event('settingsChange')
    } }
  };
  let fetcher = async url => ({ ok: true, status: url.includes('generate_204') ? 204 : 200, text: async () => '"countryCode":"JP"', json: async () => ({ ip: '203.0.113.1', country: 'Example' }) });
  // Real SHA-256, but resolved as a microtask: webcrypto completes on the thread pool, which would
  // make the setImmediate-based in-flight checks below depend on timing.
  const nodeCrypto = require('node:crypto'), crypto = { randomUUID: () => nodeCrypto.randomUUID(), subtle: { digest: async (_alg, data) => nodeCrypto.createHash('sha256').update(data).digest() } };
  const context = { ProxyCore: C, chrome, console, AbortController, performance, URL, TextEncoder, crypto,
    setTimeout, clearTimeout, fetch: async (...args) => { state.fetchCount++; return fetcher(...args); } };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(base, 'background/service_worker.js'), 'utf8').replace('import "../lib/core.js";', '');
  vm.runInContext(source + '\nglobalThis.api={dispatch,getState,sample,changeConfig,fetchEgress,checkLanding,testConnectivity,fetchTimed};', context);
  return { data, state, events, calls, chrome, api: context.api, setFetch: fn => { fetcher = fn; }, send: (type, args = {}, sender = {}) => context.api.dispatch({ type, ...args }, sender) };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('PAC denies fallback by default and opts in explicitly', () => {
  assert.equal(pac()('example.org'), 'PROXY 127.0.0.1:7897');
  assert.equal(pac({ allowDirectFallback: true })('example.org'), 'PROXY 127.0.0.1:7897; DIRECT');
});
test('PAC direct domain boundaries, case and trailing dots', () => {
  const route = pac(); assert.equal(route('WWW.BAIDU.COM.'), 'DIRECT'); assert.equal(route('foo.cn'), 'DIRECT');
  assert.notEqual(route('evilbaidu.com'), 'DIRECT'); assert.notEqual(route('baidu.com.attacker.org'), 'DIRECT');
});
test('complete private IPv4 ranges and non-private boundaries', () => {
  const route = pac();
  for (const host of ['10.0.0.1', '172.16.0.1', '172.20.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '127.2.3.4', 'router', 'a.local', 'a.localhost']) assert.equal(route(host), 'DIRECT', host);
  for (const host of ['172.15.1.1', '172.32.0.1', '192.169.0.1', '8.8.8.8']) assert.notEqual(route(host), 'DIRECT', host);
});
test('IPv6 loopback, ULA, link-local and mapped private IPs', () => {
  const route = pac();
  for (const host of ['::1', '[::1]', '0:0:0:0:0:0:0:1', 'fc00::1', 'fdff::abcd', 'fe80::1', 'febf::123', '::ffff:192.168.1.1', '::ffff:c0a8:101']) assert.equal(route(host), 'DIRECT', host);
  for (const host of ['2001:4860:4860::8888', 'fec0::1', '::ffff:8.8.8.8']) assert.notEqual(route(host), 'DIRECT', host);
});
test('SOCKS5 PAC and mandatory PAC flag', () => {
  const c = C.config({ enabled: true, mode: 'pac', profiles: [{ id: 'a', name: 'A', scheme: 'socks5', host: '::1', port: 1080 }], activeId: 'a' });
  assert.match(C.buildPacScript(c), /SOCKS5 \[::1\]:1080/); assert.equal(C.buildProxyValue(c).pacScript.mandatory, true);
});
test('strict port validation rejects zero, fractions, range, empty, booleans and injection', () => {
  for (const port of [0, -1, 65536, 1.5, '', '7890oops', true, null, Infinity]) assert.throws(() => C.profile({ id: 'x', name: 'x', host: 'localhost', scheme: 'http', port }), /端口/);
  assert.equal(C.profile({ id: 'x', name: 'x', host: 'localhost', scheme: 'http', port: '7890' }).port, 7890);
});
test('host validation rejects PAC injection, credentials, protocol and invalid addresses', () => {
  for (const host of ['https://localhost', 'a:7890', 'foo; DIRECT', 'user@host', 'a/b', '999.1.1.1', '127.01.0.1', 'a";return "DIRECT', '[::1', '::::']) assert.throws(() => C.normalizeHost(host), host);
  assert.equal(C.normalizeHost('[::1]'), '::1'); assert.equal(C.normalizeHost('LOCALHOST.'), 'localhost');
});
test('legacy migration disables fallback and keeps explicit profiles', () => {
  const c = C.config({ enabled: true, profiles: [{ id: 'x', name: 'old', host: '127.0.0.1', port: 7890, scheme: 'http' }], activeId: 'x' });
  assert.equal(c.allowDirectFallback, false); assert.equal(c.profiles[0].port, 7890); assert.equal(c.float.mini, false);
});
test('bad stored config is not silently converted to a different proxy', () => {
  assert.throws(() => C.config({ profiles: [] })); assert.throws(() => C.config({ mode: 'invalid' }));
});
test('sample metrics show latest failure and do not bridge missing samples', () => {
  assert.equal(C.stats([10, 20, null]).current, null); assert.equal(C.stats([10, null, 50]).jitter, null);
  assert.equal(C.stats([10, 20, null, 50, 70]).jitter, 15);
});
test('disabled direct and system settings are distinct', () => {
  assert.deepEqual(C.buildProxyValue(C.config({ routing: 'direct' })), { mode: 'direct' });
  assert.equal(C.buildProxyValue(C.config({ routing: 'system' })), null);
});
test('status separates configured, tested, failure, takeover and effective mismatch', () => {
  const c = C.config({ enabled: true }), own = { levelOfControl: 'controlled_by_this_extension', value: C.buildProxyValue(c) };
  assert.equal(C.status(c, own, null, 'key').code, 'unverified');
  assert.equal(C.status(c, own, { ok: true, routeKey: 'key', at: Date.now() }, 'key').code, 'reachable');
  assert.equal(C.status(c, own, { ok: false, routeKey: 'key', at: Date.now() }, 'key').code, 'failed');
  assert.equal(C.status(c, { ...own, levelOfControl: 'controlled_by_other_extensions' }, null, 'key').code, 'taken_over');
  assert.equal(C.status(c, { ...own, value: { mode: 'direct' } }, null, 'key').code, 'mismatch');
});
test('connection enables configuration but does not claim verified network', async () => {
  const f = worker(), r = await f.send('connect'); assert(r.ok); assert.equal(r.status.code, 'unverified'); assert.equal(f.state.fetchCount, 0);
});
test('disconnect explicitly forces direct, release clears ownership', async () => {
  const f = worker(); await f.send('connect'); let r = await f.send('disconnect');
  assert.equal(f.state.setting.value.mode, 'direct'); assert.equal(r.status.code, 'direct');
  r = await f.send('releaseProxy'); assert.equal(f.calls.at(-1), null); assert.equal(r.status.code, 'system');
});
test('same desired configuration can be explicitly reapplied', async () => {
  const f = worker(); await f.send('connect'); f.state.setting = { value: { mode: 'system' }, levelOfControl: 'controllable_by_this_extension' };
  const r = await f.send('connect'); assert.equal(r.status.code, 'unverified'); assert.equal(f.state.setting.value.mode, 'fixed_servers');
});
test('other extension control prevents changes and persistence', async () => {
  const f = worker(); f.state.setting.levelOfControl = 'controlled_by_other_extensions';
  await assert.rejects(f.send('connect'), /控制/); assert.equal(f.calls.length, 0); assert.equal(f.data.config, undefined);
});
test('apply failure keeps old config and restores prior proxy', async () => {
  const f = worker(); await f.send('connect'); const previous = copy(f.data.config), value = copy(f.state.setting);
  f.state.failProxy = true; await assert.rejects(f.send('setMode', { mode: 'pac' }));
  assert.deepEqual(f.data.config, previous); assert.deepEqual(f.state.setting, value);
});
test('persistence failure rolls browser settings back', async () => {
  const f = worker(); f.state.failStorage = true;
  await assert.rejects(f.send('connect'), /storage failure/); assert.equal(f.data.config, undefined); assert.equal(f.state.setting.value.mode, 'system');
});
test('rollback failure is reported rather than pretending success', async () => {
  const f = worker(); f.state.failStorage = true; f.state.failRollback = true;
  await assert.rejects(f.send('connect'), /回滚未完成/); assert(f.data.proxyError);
});
test('invalid profile and mode never change storage or proxy', async () => {
  const f = worker(); await assert.rejects(f.send('saveProfile', { profile: { name: 'bad', scheme: 'http', host: 'localhost', port: -1 } }));
  await assert.rejects(f.send('connect', { mode: 'invalid' })); assert.equal(f.calls.length, 0); assert.equal(f.data.config, undefined);
});
test('concurrent configuration updates do not clobber theme or float', async () => {
  const f = worker(); await Promise.all([f.send('setTheme', { theme: 'neon' }), f.send('setFloatOptions', { patch: { mini: true, x: 32, y: 40 } })]);
  assert.equal(f.data.config.theme, 'neon'); assert.equal(f.data.config.float.mini, true); assert.equal(f.data.config.float.x, 32);
});
test('parallel sample clients share one probe and one append', async () => {
  const f = worker(), gate = deferred(); f.setFetch(async () => { await gate.promise; return { ok: true, status: 204 }; });
  const requests = Array.from({ length: 20 }, () => f.send('sample'));
  await new Promise(r => setImmediate(r)); assert.equal(f.state.fetchCount, 1); gate.resolve();
  const results = await Promise.all(requests); assert(results.every(r => r.ok)); assert.equal(f.data.monitor.samples.length, 1);
  await f.send('sample'); assert.equal(f.state.fetchCount, 1); assert.equal(f.data.monitor.samples.length, 1);
});
test('successful readable 204 produces healthy route status', async () => {
  const f = worker(); await f.send('connect'); const sample = await f.send('sample'); assert(sample.probeOk);
  assert.equal((await f.send('getState')).status.code, 'reachable');
});
test('HTTP error, opaque response and wrong 200 are not successful probes', async () => {
  for (const response of [{ ok: false, status: 403 }, { ok: false, status: 0, type: 'opaque' }, { ok: true, status: 200 }]) {
    const f = worker(); f.setFetch(async () => response); const result = await f.send('test'); assert.equal(result.ok, false); assert.equal(f.data.monitor.samples[0], null);
  }
});
test('old probe cannot overwrite new route monitor', async () => {
  const f = worker(); await f.send('connect'); const gate = deferred(); f.setFetch(async () => { await gate.promise; return { ok: true, status: 204 }; });
  const pending = f.send('sample'); await new Promise(r => setImmediate(r)); await f.send('setMode', { mode: 'pac' }); gate.resolve();
  assert.equal((await pending).stale, true); assert.equal(f.data.monitor, null);
});
test('configuration change resets samples and egress cache', async () => {
  const f = worker(); await f.send('connect'); await f.send('sample'); await f.send('egress');
  assert(f.data.egress); await f.send('setMode', { mode: 'pac' }); assert.equal(f.data.egress, null); assert.equal(f.data.monitor, null);
});
test('egress parallel calls coalesce and stale route is discarded', async () => {
  const f = worker(), gate = deferred(); f.setFetch(async () => { await gate.promise; return { ok: true, status: 200, json: async () => ({ ip: '203.0.113.1' }) }; });
  const one = f.send('egress'), two = f.send('egress'); await new Promise(r => setImmediate(r)); assert.equal(f.state.fetchCount, 1);
  await f.send('connect'); gate.resolve(); assert.equal((await one).stale, true); assert.equal((await two).stale, true); assert.equal(f.data.egress, null);
});
test('fetch timers cover body consumption, not just response headers', async () => {
  const f = worker(); f.setFetch(async (_url, options) => ({ ok: true, status: 200, text: () => new Promise((_r, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), { name: 'AbortError' })))) }));
  await assert.rejects(f.api.fetchTimed('https://fixture.invalid', 10), /aborted/);
});
test('probe request does not use no-cors or cookies and disallows redirects', async () => {
  const f = worker(); let options; f.setFetch(async (_url, opts) => { options = opts; return { ok: true, status: 204 }; });
  await f.send('sample'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.notEqual(options.mode, 'no-cors');
});
test('streaming result never labels HTTP 200 as full unlock', async () => {
  const f = worker(); const r = await f.send('landing'); assert.equal(r.netflix.level, 'unknown'); assert.equal(r.netflix.playbackVerified, false); assert.equal(r.referenceOnly, true);
});
test('failed streaming pages do not claim unsupported region', async () => {
  const f = worker(); f.setFetch(async () => { throw Error('network'); });
  const r = await f.send('landing'); assert.equal(r.netflix.level, 'unknown'); assert(r.netflix.pages.every(p => !p.accessible));
});
test('content script cannot overwrite profiles or set arbitrary proxy data', async () => {
  const f = worker(); await assert.rejects(f.send('saveProfile', {}, { tab: { id: 1 } }), /网页脚本/);
  await assert.rejects(f.send('setFloatOptions', { patch: { profiles: [] } }, { tab: { id: 1 } }));
});
test('profile IDs unique and last config cannot be deleted', async () => {
  const f = worker(); await assert.rejects(f.send('deleteProfile', { id: 'default' }));
  await f.send('saveProfile', { profile: { name: 'Two', scheme: 'http', host: 'localhost', port: 7890 } });
  assert.equal(f.data.config.profiles.length, 2); assert.notEqual(f.data.config.activeId, 'default');
});
test('Chrome message adapter reports backend errors', async () => {
  const f = worker(); const result = await new Promise(resolve => f.events.message({ type: 'connect', mode: 'bad' }, { id: 'fixture' }, resolve));
  assert.equal(result.ok, false); assert.match(result.error, /模式/);
});
test('fixed proxy has complete explicit private network exclusions', () => {
  const rules = C.buildProxyValue(C.config({ enabled: true })).rules;
  assert(rules.bypassList.includes('172.16.0.0/12')); assert(rules.bypassList.includes('[fc00::]/7'));
});
function popup(f) {
  const elements = {}, callbacks = {}, html = fs.readFileSync(path.join(base, 'popup/popup.html'), 'utf8');
  const classes = () => ({ toggle: () => {}, add: () => {}, remove: () => {} });
  const gradient = { addColorStop: () => {} };
  const canvasCalls = [];
  const canvas = new Proxy({}, { get: (_t, key) => key === 'createLinearGradient' ? () => gradient : (...args) => canvasCalls.push({ method: key, args }) });
  for (const id of [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1])) elements[id] = { value: '', textContent: '', className: '', checked: false, disabled: false, clientWidth: 260, classList: classes(), setAttribute: () => {},
    addEventListener: (type, fn) => { callbacks[id + ':' + type] = fn; }, appendChild: () => {}, getContext: () => canvas };
  const document = { getElementById: id => { assert(elements[id], 'missing HTML id ' + id); return elements[id]; },
    documentElement: { dataset: {} }, querySelectorAll: () => [], addEventListener: () => {}, createElement: () => ({}) };
  const chrome = { runtime: { lastError: null, getManifest: () => JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')), sendMessage: (msg, respond) => f.send(msg.type, msg).then(respond, e => respond({ ok: false, error: e.message })) }, storage: { onChanged: { addListener: () => {} } } };
  const window = { devicePixelRatio: 1, addEventListener: () => {}, confirm: () => false };
  const context = { ProxyCore: C, document, chrome, window, setTimeout, clearTimeout, getComputedStyle: () => ({ getPropertyValue: () => '' }), console };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(base, 'popup/popup.js'), 'utf8') + '\nglobalThis.ui={accept,refreshState,renderStatus,renderMonitor,chartTangents,setSamples(value){samples=value;renderMonitor();}};', context);
  return { elements, callbacks, ui: context.ui, window, canvasCalls };
}
test('popup reflects backend status, not merely enabled flag', async () => {
  const f = worker(), p = popup(f); const r = await f.send('connect'); p.ui.accept(r);
  assert.match(p.elements.status.textContent, /待验证/);
  await f.send('sample'); p.ui.accept(await f.send('getState')); assert.equal(p.elements.status.textContent, 'HTTP 可达');
});
test('popup invalid port save displays backend validation error', async () => {
  const f = worker(), p = popup(f); p.ui.accept(await f.send('getState'), true);
  Object.assign(p.elements.pname, { value: 'test' }); p.elements.scheme.value = 'http'; p.elements.host.value = 'localhost'; p.elements.port.value = '-1';
  await p.callbacks['saveProfile:click'](); assert.match(p.elements.msg.textContent, /端口/); assert.equal(f.data.config, undefined);
});
test('popup failed disconnect does not report successful direct mode', async () => {
  const f = worker(), p = popup(f); p.ui.accept(await f.send('connect'));
  f.state.setting.levelOfControl = 'controlled_by_other_extensions';
  await p.callbacks['modes:click']({ target: { closest: selector => selector === '.disc' ? { disabled: false } : null } });
  assert.match(p.elements.msg.textContent, /控制/); assert.doesNotMatch(p.elements.msg.textContent, /已显式设置/);
});
test('popup fallback requires explicit user confirmation', async () => {
  const f = worker(), p = popup(f); p.ui.accept(await f.send('getState'));
  p.elements.allowFallback.checked = true; await p.callbacks['allowFallback:change']();
  assert.equal(p.elements.allowFallback.checked, false); assert.equal(f.data.config, undefined);
});
test('manifest scripts exist and probe origin permission is explicit', () => {
  const m = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
  assert(m.host_permissions.includes('https://www.gstatic.com/*')); assert.equal(m.version, '0.5.7');
  for (const script of m.content_scripts[0].js) assert(fs.existsSync(path.join(base, script)));
  assert(fs.existsSync(path.join(base, m.background.service_worker)));
});
test('content script no longer writes config directly and requires trusted clicks', () => {
  const content = fs.readFileSync(path.join(base, 'content/floating.js'), 'utf8');
  assert.doesNotMatch(content, /chrome\.storage\.local\.set/); assert.match(content, /!e\.isTrusted/); assert.match(content, /type: "cycleMode"/);
});
test('upgrade reapplies saved PAC without retaining legacy DIRECT fallback', async () => {
  const f = worker(); f.data.config = { enabled: true, mode: 'pac' };
  f.state.setting = { value: { mode: 'pac_script', pacScript: { data: 'legacy; DIRECT' } }, levelOfControl: 'controlled_by_this_extension' };
  await f.events.installed();
  assert.equal(f.state.setting.value.pacScript.mandatory, true);
  assert.equal(f.data.config.allowDirectFallback, false);
  const context = {}; vm.createContext(context); vm.runInContext(f.state.setting.value.pacScript.data, context);
  assert.equal(context.FindProxyForURL('https://example.org', 'example.org'), 'PROXY 127.0.0.1:7897'); assert.equal(f.state.fetchCount, 0);
});

test('native popup sizing never depends on viewport width', () => {
  const css = fs.readFileSync(path.join(base, 'popup/popup.css'), 'utf8');
  assert.doesNotMatch(css, /width\s*:\s*[\d.]+vw/);
  assert.doesNotMatch(css, /@media\s*\(max-width:/);
  assert.match(css, /min-width:\s*392px/);
});

test('egress information has theme-aware visual emphasis', () => {
  const css = fs.readFileSync(path.join(base, 'popup/popup.css'), 'utf8');
  assert.match(css, /\.egress-row\s*\{[^}]*border-left:\s*3px solid var\(--accent\)/);
  assert.match(css, /\.egress-row\s*\{[^}]*background:\s*var\(--accent-soft\)/);
  assert.match(css, /#egress\s*\{[^}]*font-weight:\s*650/);
});

test('button SVGs retain accessible labels and dynamic updates do not remove icons', () => {
  const html = fs.readFileSync(path.join(base, 'popup/popup.html'), 'utf8');
  const js = fs.readFileSync(path.join(base, 'popup/popup.js'), 'utf8');
  for (const id of ['theme', 'manageBtn', 'test', 'refreshIp', 'floatToggle', 'landing', 'saveProfile', 'newProfile', 'deleteProfile', 'releaseProxy']) {
    const button = html.match(new RegExp('<button\\b[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</button>'));
    assert(button, id);
    assert.match(button[1], /<svg[^>]*aria-hidden="true"/);
  }
  assert.doesNotMatch(js, /\$\("(?:theme|floatToggle)"\)\.textContent\s*=/);
});

test('browser-neutral branding omits Chrome-only badge and dynamic title', () => {
  const html = fs.readFileSync(path.join(base, 'popup/popup.html'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
  const worker = fs.readFileSync(path.join(base, 'background/service_worker.js'), 'utf8');
  assert.doesNotMatch(html, /仅\s*Chrome|Chrome 代理开关/);
  assert.equal(manifest.name, '代理开关 (Clash/mihomo)');
  assert.equal(manifest.action.default_title, '代理开关');
  assert.doesNotMatch(worker, /Chrome 代理开关/);
});

test('chart smooth interpolation preserves extrema without overshoot', () => {
  const p = popup(worker());
  for (const ys of [[10, 50, 11, 30], [1, 2, 40, 41], [40, 40, 10, 10], [1, 1000, 1], [3], []]) {
    const points = ys.map((y, x) => ({ x, y }));
    const slopes = p.ui.chartTangents(points);
    for (let i = 1; i < ys.length; i++) {
      const controls = [ys[i-1], ys[i-1] + slopes[i-1]/3, ys[i] - slopes[i]/3, ys[i]];
      for (let k = 0; k <= 100; k++) {
        const t = k/100, u = 1-t;
        const y = u*u*u*controls[0] + 3*u*u*t*controls[1] + 3*u*t*t*controls[2] + t*t*t*controls[3];
        assert(y >= Math.min(ys[i-1],ys[i])-1e-8 && y <= Math.max(ys[i-1],ys[i])+1e-8);
      }
    }
  }
});
test('smooth chart never connects across failed samples or averages metrics', () => {
  const p = popup(worker()); p.canvasCalls.length = 0;
  p.ui.setSamples([100, 140, null, 80, 90]);
  // One cubic per successful adjacent pair, rendered twice (area and stroke).
  assert.equal(p.canvasCalls.filter(c => c.method === 'bezierCurveTo').length, 4);
  assert.equal(p.elements.latency.textContent, 90);
  assert.match(p.elements.sampleFailures.textContent, /失败 1/);
  p.canvasCalls.length = 0; p.ui.setSamples([null, 90, null]);
  assert.equal(p.canvasCalls.filter(c => c.method === 'bezierCurveTo').length, 0);
  assert.equal(p.canvasCalls.filter(c => c.method === 'arc').length, 1);
  p.ui.setSamples([90,100]); assert.equal(p.elements.sampleFailures.textContent, '');
  p.ui.setSamples([]); assert.equal(p.elements.sampleFailures.textContent, '');
});

// 0.4.1 stored profiles without validation: host could contain a port, ports were unchecked.
const legacy = activeId => ({ enabled: true, theme: 'light', float: { enabled: false, x: null, y: null }, mode: 'global', activeId,
  profiles: [{ id: 'default', name: '本地 Clash', scheme: 'http', host: '127.0.0.1', port: 7897 },
    { id: 'p1730000000000', name: '公司', scheme: 'http', host: '10.0.0.5:7890', port: 7897 }] });
test('upgrade removes invalid unused legacy profile and reports it', async () => {
  const f = worker(); f.data.config = legacy('default');
  await f.events.installed();
  assert.deepEqual(f.data.config.profiles.map(p => p.id), ['default']);
  assert.equal(f.state.setting.value.rules.singleProxy.port, 7897);
  assert.match(f.data.configNotice[0].error, /端口/);
  const p = popup(f); p.ui.accept(await f.send('getState'), true);
  assert.match(p.elements.notice.textContent, /公司.*10\.0\.0\.5:7890/);
  await p.callbacks['notice:click']();
  assert.equal(p.elements.notice.textContent, ''); assert.equal(f.data.configNotice, null);
});
test('invalid in-use legacy profile is never silently replaced, but direct still works', async () => {
  const f = worker(); f.data.config = legacy('p1730000000000');
  const applied = { value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 7897 } } }, levelOfControl: 'controlled_by_this_extension' };
  f.state.setting = copy(applied);
  await f.events.installed();
  assert.deepEqual(f.state.setting, applied); assert.equal(f.calls.length, 0);
  await assert.rejects(f.send('getState'), /强制直连/);
  await assert.rejects(f.send('connect', { mode: 'pac' }), /强制直连/); assert.equal(f.calls.length, 0);
  const r = await f.send('disconnect');
  assert.equal(r.status.code, 'direct'); assert.deepEqual(f.state.setting.value, { mode: 'direct' });
  assert.deepEqual(f.data.config.profiles.map(p => p.id), ['default']);
  assert.equal(r.configNotice[0].name, '公司');
});
test('host with a port explains where the port belongs', () => {
  assert.throws(() => C.normalizeHost('10.0.0.5:7890'), /端口/); assert.throws(() => C.normalizeHost('localhost:7890'), /端口/);
  assert.throws(() => C.normalizeHost('::::'), /IPv6/); assert.equal(C.normalizeHost('::1'), '::1');
});
test('proxy error burst is coalesced and never blocks switching to direct', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = worker(); await f.send('connect', { mode: 'global' });
  const burst = () => { for (let i = 0; i < 200; i++) f.events.proxyError({ fatal: false, error: 'net::ERR_PROXY_CONNECTION_FAILED', details: '' }); };
  burst();
  assert.equal((await f.send('disconnect')).status.code, 'direct');
  await f.send('connect', { mode: 'global' }); burst();
  t.mock.timers.tick(1000); await new Promise(setImmediate);
  assert.equal(f.state.sets.filter(keys => keys.length === 1 && keys[0] === 'proxyError').length, 1);
  assert.equal((await f.send('getState')).status.code, 'proxy_error');
});
test('content script without an overlay never messages the worker', async () => {
  const sent = [], listeners = [], stored = { config: C.config({}) };
  const chrome = { runtime: { sendMessage: async m => { sent.push(m.type); return { ok: true, routeKey: 'k', config: C.config({}) }; } },
    storage: { local: { get: async key => ({ [key]: copy(stored[key]) }) }, onChanged: { addListener: fn => listeners.push(fn) } } };
  const context = { chrome, ProxyCore: C, window: { addEventListener: () => {} }, document: { addEventListener: () => {}, visibilityState: 'visible' }, setTimeout, clearTimeout };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(base, 'content/floating.js'), 'utf8'), context);
  await new Promise(setImmediate); assert.deepEqual(sent, []);
  listeners[0]({ health: {}, proxyError: {}, egress: {} }, 'local');
  listeners[0]({ config: { newValue: C.config({ theme: 'dark' }) } }, 'local'); await new Promise(setImmediate);
  assert.deepEqual(sent, []);
  listeners[0]({ config: { newValue: C.config({ float: { enabled: true } }) } }, 'local'); assert.deepEqual(sent, ['getState']);
});
test('content script asks the worker for state only when the overlay is enabled', async () => {
  const sent = [];
  const chrome = { runtime: { sendMessage: async m => { sent.push(m.type); return { ok: false }; } },
    storage: { local: { get: async () => ({ config: C.config({ float: { enabled: true } }) }) }, onChanged: { addListener: () => {} } } };
  const context = { chrome, ProxyCore: C, window: { addEventListener: () => {} }, document: { addEventListener: () => {}, visibilityState: 'visible' }, setTimeout, clearTimeout };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(base, 'content/floating.js'), 'utf8'), context);
  await new Promise(setImmediate); assert.deepEqual(sent, ['getState']);
});
test('a fresh probe updates the toolbar once and skips unchanged badge writes', async () => {
  const f = worker(); await f.send('connect');
  let actions = 0; const count = fn => async (...a) => { actions++; return fn(...a); };
  const { action } = f.chrome; Object.assign(action, { setBadgeText: count(action.setBadgeText), setBadgeBackgroundColor: count(action.setBadgeBackgroundColor), setTitle: count(action.setTitle) });
  await f.send('probe'); assert.equal(actions, 0, 'probe success leaves an ON badge unchanged');
  f.setFetch(async () => ({ ok: false, status: 502 })); await f.send('probe');
  assert.equal(f.state.badge, '!'); assert.equal(actions, 3);
});
test('streaming checks follow same-site regional redirects; probe and egress never follow', async () => {
  const f = worker(), modes = []; let target = 'https://www.netflix.com/hk-en';
  f.setFetch(async (url, options) => {
    if (!url.includes('netflix') && !url.includes('youtube')) modes.push(options.redirect);
    if (url.includes('/title/')) {
      if (options.redirect === 'error') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, redirected: true, url: url.replace('https://www.netflix.com', target), text: async () => '' };
    }
    return { ok: true, status: url.includes('generate_204') ? 204 : 200, redirected: false, url, text: async () => '"countryCode":"HK"', json: async () => ({ ip: '203.0.113.1' }) };
  });
  let r = await f.send('landing');
  assert(r.netflix.pages.every(p => p.accessible)); assert.equal(r.youtube.region, 'HK');
  target = 'https://login.example';
  r = await f.send('landing');
  assert(r.netflix.pages.every(p => !p.accessible && /其他站点/.test(p.error)));
  await f.send('sample'); await f.send('egress');
  assert.deepEqual([...new Set(modes)], ['error']); assert.equal(modes.length, 2);
});
test('egress tries ipinfo.io first, which is reachable when forced direct', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8')); assert(m.host_permissions.includes('https://ipinfo.io/*'));
  const f = worker(), urls = [];
  f.setFetch(async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({ ip: '198.51.100.7', country: 'CN', city: 'Shanghai', org: 'AS64500 Example Net' }) }; });
  const r = await f.send('egress');
  assert.deepEqual(urls, ['https://ipinfo.io/json']);
  assert.equal(r.ip, '198.51.100.7'); assert.equal(r.code, 'CN'); assert.equal(r.city, 'Shanghai'); assert.equal(r.isp, 'Example Net');
});
test('popup shows why every egress service failed instead of a bare unknown', async () => {
  const f = worker(), p = popup(f), urls = [];
  f.setFetch(async url => {
    urls.push(url);
    if (url.includes('ipinfo')) throw new TypeError('Failed to fetch');
    if (url.includes('ip.sb')) throw Object.assign(Error('aborted'), { name: 'AbortError' });
    return { ok: false, status: 403 };
  });
  p.ui.accept(await f.send('getState')); await p.callbacks['refreshIp:click']();
  assert.deepEqual(urls.map(u => new URL(u).host), ['ipinfo.io', 'api.ip.sb', 'ipapi.co']);
  assert.equal(p.elements.egress.textContent, '未知');
  assert.equal(p.elements.isp.textContent, '出口查询失败：ipinfo.io 无法连接；api.ip.sb 超时；ipapi.co HTTP 403');
});
test('popup recovering from an unreadable config redraws profiles and never saves over one', async () => {
  const f = worker(); f.data.config = legacy('p1730000000000');
  f.state.setting = { value: { mode: 'fixed_servers', rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 7897 } } }, levelOfControl: 'controlled_by_this_extension' };
  const p = popup(f); await p.ui.refreshState();
  assert.match(p.elements.msg.textContent, /强制直连/);
  Object.assign(p.elements.pname, { value: '公司' }); p.elements.scheme.value = 'http'; p.elements.host.value = '10.0.0.5'; p.elements.port.value = '7890';
  await p.callbacks['saveProfile:click'](); await p.callbacks['deleteProfile:click']();
  assert.deepEqual(f.data.config, legacy('p1730000000000'));
  await p.callbacks['modes:click']({ target: { closest: selector => selector === '.disc' ? { disabled: false } : null } });
  assert.equal(p.elements.profile.value, 'default');
  assert.equal(p.elements.pname.value, '本地 Clash'); assert.equal(p.elements.host.value, '127.0.0.1');
});
test('PAC route key stays short, so each probe writes no copy of the PAC script', async () => {
  const f = worker(); await f.send('connect', { mode: 'pac' }); await f.send('sample');
  assert.match(f.data.monitor.routeKey, /^[0-9a-f]{64}$/);
  assert(JSON.stringify({ monitor: f.data.monitor, health: f.data.health }).length < 1000);
  const before = f.data.monitor.routeKey; await f.send('setFallback', { enabled: true });
  assert.notEqual((await f.send('getState')).routeKey, before);
});
test('popup footer shows the manifest version', () => {
  const p = popup(worker()), m = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
  assert.equal(p.elements.version.textContent, 'v' + m.version);
});
