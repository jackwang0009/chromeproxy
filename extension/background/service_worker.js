// Chromium browser-scoped proxy controller. No system proxy, TUN or Clash control API.
import "../lib/core.js";
const C = globalThis.ProxyCore;
const SAMPLE_INTERVAL = 1500, SAMPLE_MAX = 40, PROXY_ERROR_INTERVAL = 1000;
const TEST_URL = "https://www.gstatic.com/generate_204";
let mutationTail = Promise.resolve(), pendingMutations = 0, routeEpoch = 0;
let probeFlight = null, egressFlight = null, landingFlight = null;
let lastProxyError = null, pendingProxyError = null, proxyErrorTimer = null;
function enqueue(fn) {
  if (pendingMutations >= 64) return Promise.reject(new Error("操作队列繁忙，请稍后再试"));
  pendingMutations++;
  const pending = mutationTail.then(fn, fn).finally(() => pendingMutations--);
  mutationTail = pending.catch(() => {}); return pending;
}
async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return C.repair(config).config;
}
async function sha256(text) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}
async function routeContext() {
  const epoch = routeEpoch;
  const cfg = await getConfig(), setting = await chrome.proxy.settings.get({});
  // Hashed: in PAC mode setting.value holds the whole script (~3 KB), and the key is copied into
  // every monitor, health and egress write.
  const routeKey = await sha256(C.stable({ enabled: cfg.enabled, routing: cfg.routing, mode: cfg.mode, activeId: cfg.activeId, fallback: cfg.allowDirectFallback, value: setting.value, control: setting.levelOfControl }));
  if (epoch !== routeEpoch) throw new Error("代理正在切换，请稍后重试");
  return { epoch, cfg, setting, routeKey };
}
// Returns the fresh context when the route is unchanged, so callers can reuse it instead of re-reading.
async function sameRoute(context) {
  if (context.epoch !== routeEpoch) return null;
  const current = await routeContext(); return context.routeKey === current.routeKey ? current : null;
}
async function getState(context) {
  const ctx = context || await routeContext(), { health, proxyError, egress, configNotice } = await chrome.storage.local.get(["health", "proxyError", "egress", "configNotice"]);
  const error = lastProxyError || proxyError || null;
  return { ok: true, config: ctx.cfg, control: ctx.setting.levelOfControl, effectiveProxy: ctx.setting.value,
    status: C.status(ctx.cfg, ctx.setting, health, ctx.routeKey, error),
    health: health?.routeKey === ctx.routeKey ? health : null, routeKey: ctx.routeKey,
    egress: egress?.routeKey === ctx.routeKey ? egress : null, lastProxyError: error, configNotice: Array.isArray(configNotice) ? configNotice : [] };
}
// Probes run every 1.5 s while a panel is visible; only touch the toolbar when the badge changes.
let lastBadge = null;
async function updateBadge(context) {
  try {
    const s = await getState(context);
    const text = ["failed", "proxy_error", "mismatch", "taken_over"].includes(s.status.code) ? "!" : s.config.enabled ? "ON" : s.status.code === "direct" ? "直" : "";
    const color = s.config.enabled ? "#d97706" : "#64748b";
    const title = "代理开关：" + (s.config.enabled ? "代理已启用；打开面板查看实时检测状态" : s.status.label);
    const key = C.stable([text, color, title]);
    if (key === lastBadge) return;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title });
    lastBadge = key;
  } catch (_) { lastBadge = null; await chrome.action.setBadgeText({ text: "ERR" }).catch(() => {}); }
}
function controlled(setting) {
  if (["controlled_by_other_extensions", "not_controllable"].includes(setting.levelOfControl)) throw new Error("代理被其他扩展或策略控制，未修改配置");
}
async function applyValue(value) {
  if (value) await chrome.proxy.settings.set({ scope: "regular", value });
  else await chrome.proxy.settings.clear({ scope: "regular" });
}
// Only this queue writes config. Apply first, verify, persist; on persistence/apply failure restore prior ownership.
async function changeConfig(transform, forceRouting = false) {
  return enqueue(async () => {
    const { config: raw, configNotice } = await chrome.storage.local.get(["config", "configNotice"]);
    let before = null, next, removed;
    try {
      ({ config: before, removed } = C.repair(raw));
      next = C.config(await transform(before));
    } catch (error) {
      if (before) throw error;
      // Stored config is unreadable (invalid in-use profile). Accept the operation only if it takes
      // that profile out of use, e.g. direct or release; anything else keeps the original error.
      try { ({ config: next, removed } = C.repair(await transform({ ...C.DEFAULTS, ...raw }))); } catch (_) { throw error; }
    }
    const notice = removed.length ? { configNotice: [...(Array.isArray(configNotice) ? configNotice : []), ...removed].slice(-20) } : {};
    const oldValue = before && C.buildProxyValue(before), newValue = C.buildProxyValue(next);
    const routeChanged = forceRouting || !before || !C.sameProxy(oldValue, newValue) && !(oldValue === null && newValue === null) || before.activeId !== next.activeId;
    if (!routeChanged) {
      await chrome.storage.local.set({ config: next, ...notice });
      return getState();
    }
    const previous = await chrome.proxy.settings.get({}); controlled(previous);
    routeEpoch++; let applied = false;
    try {
      applied = true; await applyValue(newValue);
      const effective = await chrome.proxy.settings.get({});
      if (newValue && (effective.levelOfControl !== "controlled_by_this_extension" || !C.sameProxy(newValue, effective.value))) throw new Error("浏览器未应用目标代理设置");
      if (!newValue && effective.levelOfControl === "controlled_by_this_extension") throw new Error("浏览器未释放本扩展的代理设置");
      await chrome.storage.local.set({ config: next, ...notice, monitor: null, health: null, egress: null, landing: null, proxyError: null });
      lastProxyError = pendingProxyError = null;
    } catch (error) {
      let rollbackError = null;
      if (applied) {
        try {
          const current = await chrome.proxy.settings.get({});
          // Do not override a controller which took over while this operation was pending.
          if (current.levelOfControl === "controlled_by_this_extension" || current.levelOfControl === "controllable_by_this_extension") {
            await applyValue(previous.levelOfControl === "controlled_by_this_extension" ? previous.value : null);
          } else throw new Error("控制权已变化，请人工确认当前代理");
        } catch (e) { rollbackError = e.message; }
      }
      routeEpoch++;
      if (rollbackError) {
        lastProxyError = { error: "回滚未完成：" + rollbackError, at: Date.now() };
        await chrome.storage.local.set({ proxyError: lastProxyError }).catch(() => {});
      }
      await updateBadge();
      throw new Error(error.message + (rollbackError ? "；回滚未完成：" + rollbackError : "；原配置保持不变"));
    }
    await updateBadge(); return getState();
  });
}
// Probe and egress reject redirects. Streaming pages use same-site regional redirects
// (e.g. /title/x -> /hk-en/title/x), so they may follow, but never across hosts.
async function fetchTimed(url, timeout, kind = "text", redirect = "error") {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "omit", redirect, signal: controller.signal });
    if (response.redirected && new URL(response.url).host !== new URL(url).host) throw new Error("跳转到其他站点：" + new URL(response.url).host);
    if (!response.ok) throw new Error("HTTP " + response.status);
    const body = kind === "json" ? await response.json() : kind === "none" ? null : await response.text();
    return { response, body };
  } finally { clearTimeout(timer); }
}
async function testConnectivity() {
  const start = performance.now();
  try {
    const { response } = await fetchTimed(TEST_URL, 4000, "none");
    if (response.status !== 204) throw new Error("探测端点未返回预期的 204");
    return { ok: true, ms: Math.round(performance.now() - start), at: Date.now(), metric: "http_request", endpoint: TEST_URL };
  } catch (e) { return { ok: false, ms: null, at: Date.now(), error: e.name === "AbortError" ? "HTTP 探测超时" : e.message, metric: "http_request" }; }
}
async function sample(force = false) {
  const ctx = await routeContext();
  if (probeFlight?.routeKey === ctx.routeKey && probeFlight.epoch === ctx.epoch) return probeFlight.promise;
  const { monitor } = await chrome.storage.local.get("monitor");
  if (!force && monitor?.routeKey === ctx.routeKey && Date.now() - monitor.updated < SAMPLE_INTERVAL) {
    return { ok: true, ...monitor, cached: true };
  }
  // A second caller may have reached this point while awaiting the cache read.
  if (probeFlight?.routeKey === ctx.routeKey && probeFlight.epoch === ctx.epoch) return probeFlight.promise;
  const flight = { routeKey: ctx.routeKey, epoch: ctx.epoch };
  flight.promise = (async () => {
    const result = await testConnectivity();
    return enqueue(async () => {
      const current = await sameRoute(ctx);
      if (!current) return { ok: false, stale: true, error: "线路已变化，已丢弃旧探测结果" };
      const { monitor: old } = await chrome.storage.local.get("monitor");
      const samples = old?.routeKey === ctx.routeKey && Array.isArray(old.samples) ? old.samples.slice(-SAMPLE_MAX + 1) : [];
      samples.push(result.ok ? result.ms : null);
      const value = { routeKey: ctx.routeKey, samples, updated: result.at, ms: result.ms, probeOk: result.ok, error: result.error || null, metric: "http_request" };
      if (result.ok) lastProxyError = pendingProxyError = null;
      await chrome.storage.local.set({ monitor: value, health: { ...result, routeKey: ctx.routeKey }, ...(result.ok ? { proxyError: null } : {}) });
      await updateBadge(current); return { ok: true, ...value, cached: false };
    });
  })().finally(() => { if (probeFlight === flight) probeFlight = null; });
  probeFlight = flight; return flight.promise;
}
async function fetchEgress() {
  const ctx = await routeContext();
  if (egressFlight?.routeKey === ctx.routeKey && egressFlight.epoch === ctx.epoch) return egressFlight.promise;
  const { egress } = await chrome.storage.local.get("egress");
  if (egress?.routeKey === ctx.routeKey && Date.now() - egress.at < 30000) return { ok: true, ...egress, cached: true };
  if (egressFlight?.routeKey === ctx.routeKey && egressFlight.epoch === ctx.epoch) return egressFlight.promise;
  const flight = { routeKey: ctx.routeKey, epoch: ctx.epoch };
  flight.promise = (async () => {
    // From mainland China a direct request to api.ip.sb times out and ipapi.co returns a Cloudflare
    // challenge, so forced direct showed "unknown". ipinfo.io works both direct and via proxy.
    const sources = [
      { url: "https://ipinfo.io/json", map: j => ({ ip: j.ip, country: j.country, code: j.country, city: j.city, isp: typeof j.org === "string" ? j.org.replace(/^AS\d+\s+/, "") : undefined }) },
      { url: "https://api.ip.sb/geoip", map: j => ({ ip: j.ip, country: j.country, code: j.country_code, city: j.city, isp: j.isp || j.asn_organization || j.organization }) },
      { url: "https://ipapi.co/json/", map: j => ({ ip: j.ip, country: j.country_name, code: j.country_code, city: j.city, isp: j.org }) }
    ];
    const failures = [];
    for (const source of sources) {
      const host = new URL(source.url).host;
      try {
        const { body } = await fetchTimed(source.url, 5000, "json"), mapped = source.map(body || {});
        if (typeof mapped.ip !== "string" || !/^[0-9a-f:.]+$/i.test(mapped.ip)) { failures.push(host + " 返回内容无效"); continue; }
        return await enqueue(async () => {
          if (!await sameRoute(ctx)) return { ok: false, stale: true, error: "线路已变化，请重新获取出口" };
          const value = { ...mapped, at: Date.now(), routeKey: ctx.routeKey, source: source.url };
          await chrome.storage.local.set({ egress: value }); return { ok: true, ...value };
        });
      } catch (e) {
        failures.push(host + " " + (e.name === "AbortError" ? "超时" : e.name === "TypeError" ? "无法连接" : e.name === "SyntaxError" ? "返回格式无效" : e.message));
      }
    }
    return { ok: false, error: "出口查询失败：" + failures.join("；") };
  })().finally(() => { if (egressFlight === flight) egressFlight = null; });
  egressFlight = flight; return flight.promise;
}
async function checkYouTube() {
  try {
    const { body, response } = await fetchTimed("https://www.youtube.com/premium", 7000, "text", "follow");
    const match = body.match(/"countryCode"\s*:\s*"([A-Z]{2})"/) || body.match(/"GL"\s*:\s*"([A-Z]{2})"/);
    return { ok: true, region: match ? match[1] : null, evidence: "页面地区标记", httpStatus: response.status, playbackVerified: false };
  } catch (e) { return { ok: false, error: e.message, playbackVerified: false }; }
}
async function checkNetflix() {
  // Page HTTP status cannot establish playback entitlement or full/original-only unlock.
  const pages = await Promise.all(["81280792", "80018499"].map(async title => {
    try { const { response } = await fetchTimed("https://www.netflix.com/title/" + title, 7000, "text", "follow"); return { title, accessible: true, httpStatus: response.status }; }
    catch (e) { return { title, accessible: false, error: e.message }; }
  }));
  return { ok: true, level: "unknown", pages, playbackVerified: false, note: "仅检测页面可访问性，不代表解锁、订阅或可播放；重定向及网络失败均不能判定不支持" };
}
async function checkLanding() {
  const ctx = await routeContext();
  if (landingFlight?.routeKey === ctx.routeKey && landingFlight.epoch === ctx.epoch) return landingFlight.promise;
  const flight = { routeKey: ctx.routeKey, epoch: ctx.epoch };
  flight.promise = (async () => {
    const [youtube, netflix] = await Promise.all([checkYouTube(), checkNetflix()]);
    return enqueue(async () => {
      if (!await sameRoute(ctx)) return { ok: false, stale: true, error: "线路已变化，结果已丢弃" };
      return { ok: true, youtube, netflix, at: Date.now(), routeKey: ctx.routeKey, referenceOnly: true };
    });
  })().finally(() => { if (landingFlight === flight) landingFlight = null; });
  landingFlight = flight; return flight.promise;
}
function requireBoolean(value) { if (typeof value !== "boolean") throw new Error("开关必须为布尔值"); return value; }
async function dispatch(msg, sender) {
  if (!msg || typeof msg.type !== "string") throw new Error("消息格式无效");
  const fromPage = !!sender?.tab;
  const pageAllowed = ["getState", "getSamples", "sample", "egress", "cycleMode", "setFloatOptions"];
  if (fromPage && !pageAllowed.includes(msg.type)) throw new Error("网页脚本不能调用此操作");
  switch (msg.type) {
    case "getState": return getState();
    case "connect": return changeConfig(c => ({ ...c, enabled: true, mode: msg.mode === undefined ? c.mode : msg.mode }), true);
    case "disconnect": return changeConfig(c => ({ ...c, enabled: false, routing: "direct" }), true);
    case "releaseProxy": return changeConfig(c => ({ ...c, enabled: false, routing: "system" }), true);
    case "setMode": return changeConfig(c => ({ ...c, mode: msg.mode }));
    case "setTheme": return changeConfig(c => ({ ...c, theme: msg.theme }));
    case "setFallback": return changeConfig(c => ({ ...c, allowDirectFallback: requireBoolean(msg.enabled) }));
    case "setFloat": return changeConfig(c => ({ ...c, float: { ...c.float, enabled: requireBoolean(msg.enabled) } }));
    case "setFloatOptions": {
      const patch = msg.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).some(k => !["enabled", "mini", "x", "y"].includes(k))) throw new Error("悬浮窗参数无效");
      return changeConfig(c => ({ ...c, float: { ...c.float, ...patch } }));
    }
    case "cycleMode": return changeConfig(c => !c.enabled ? { ...c, enabled: true, mode: "global" } : c.mode === "global" ? { ...c, mode: "pac" } : { ...c, enabled: false, routing: "direct" });
    case "selectProfile": return changeConfig(c => { if (!c.profiles.some(p => p.id === msg.id)) throw new Error("代理配置不存在"); return { ...c, activeId: msg.id }; });
    case "saveProfile": return changeConfig(c => {
      const p = C.profile({ ...msg.profile, id: msg.profile?.id || "p" + crypto.randomUUID().replace(/-/g, "") });
      const profiles = c.profiles.slice(), index = profiles.findIndex(x => x.id === p.id);
      if (index >= 0) profiles[index] = p; else profiles.push(p);
      return { ...c, profiles, activeId: p.id };
    });
    case "deleteProfile": return changeConfig(c => {
      if (c.profiles.length <= 1) throw new Error("至少保留一组代理配置");
      if (!c.profiles.some(p => p.id === msg.id)) throw new Error("代理配置不存在");
      const profiles = c.profiles.filter(p => p.id !== msg.id);
      return { ...c, profiles, activeId: c.activeId === msg.id ? profiles[0].id : c.activeId };
    });
    case "getSamples": {
      const ctx = await routeContext(), { monitor } = await chrome.storage.local.get("monitor");
      return { ok: true, samples: monitor?.routeKey === ctx.routeKey ? monitor.samples : [], updated: monitor?.routeKey === ctx.routeKey ? monitor.updated : null };
    }
    case "probe": case "test": {
      const result = await sample(true);
      return { ...result, ok: result.ok && result.probeOk === true };
    }
    case "dismissNotice": return enqueue(async () => { await chrome.storage.local.set({ configNotice: null }); return getState(); });
    case "sample": return sample();
    case "egress": return fetchEgress();
    case "landing": return checkLanding();
    default: throw new Error("未知操作");
  }
}
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender?.id && sender.id !== chrome.runtime.id) { respond({ ok: false, error: "消息来源不合法" }); return false; }
  dispatch(msg, sender).then(respond, error => respond({ ok: false, error: error.message })); return true;
});
// A stopped proxy fails every request at once. Keep only the latest error and write at most once
// per interval, so the burst cannot fill the queue that direct/release also need.
chrome.proxy.onProxyError.addListener(details => {
  pendingProxyError = { ...details, at: Date.now() };
  if (proxyErrorTimer) return;
  proxyErrorTimer = setTimeout(() => {
    proxyErrorTimer = null;
    enqueue(async () => {
      if (!pendingProxyError) return;
      lastProxyError = pendingProxyError; pendingProxyError = null;
      await chrome.storage.local.set({ proxyError: lastProxyError }); await updateBadge();
    }).catch(() => {});
  }, PROXY_ERROR_INTERVAL);
});
// Wrapped: enqueue passes the previous queue result, which updateBadge would take as a context.
chrome.proxy.settings.onChange.addListener(() => { enqueue(() => updateBadge()).catch(() => {}); });
function restoreSavedConfiguration() {
  // Upgrades must replace an old persisted PAC which still contained a DIRECT fallback.
  return changeConfig(c => c, true).catch(async error => {
    lastProxyError = { error: error.message, at: Date.now() };
    await chrome.storage.local.set({ proxyError: lastProxyError }).catch(() => {});
    await updateBadge();
  });
}
chrome.runtime.onStartup.addListener(restoreSavedConfiguration);
chrome.runtime.onInstalled.addListener(restoreSavedConfiguration);
