/* Pure shared policy/validation. Also loaded by Node tests; no Chrome or network calls. */
(function (root) {
  "use strict";
  const DEFAULTS = {
    enabled: false, routing: "system", theme: "light", mode: "global", allowDirectFallback: false,
    float: { enabled: false, mini: false, x: null, y: null }, activeId: "default",
    profiles: [{ id: "default", name: "本地 Clash", scheme: "http", host: "127.0.0.1", port: 7897 }],
    directDomains: ["cn", "qq.com", "baidu.com", "taobao.com", "tmall.com", "jd.com", "bilibili.com", "163.com", "126.com", "weibo.com", "zhihu.com", "aliyun.com", "alipay.com", "douyin.com", "iqiyi.com", "youku.com", "sohu.com", "sina.com.cn", "csdn.net", "gitee.com", "mi.com", "meituan.com", "ele.me", "12306.cn"]
  };
  function assert(condition, message) { if (!condition) throw new Error(message); }
  function ipv6Words(input) {
    var s = input.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
    if (s.indexOf(":") < 0 || !/^[0-9a-f:.]+$/.test(s)) return null;
    if (s.indexOf(".") >= 0) {
      var at = s.lastIndexOf(":"), tail = s.slice(at + 1).split(".");
      if (tail.length !== 4 || tail.some(function (v) { return !/^\d{1,3}$/.test(v) || +v > 255; })) return null;
      s = s.slice(0, at + 1) + ((+tail[0] << 8) | +tail[1]).toString(16) + ":" + ((+tail[2] << 8) | +tail[3]).toString(16);
    }
    var halves = s.split("::");
    if (halves.length > 2) return null;
    var left = halves[0] ? halves[0].split(":") : [], right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    var all = left.concat(right);
    if (all.some(function (v) { return !/^[0-9a-f]{1,4}$/.test(v); })) return null;
    if (halves.length === 1 && left.length !== 8 || halves.length === 2 && all.length >= 8) return null;
    while (halves.length === 2 && left.length + right.length < 8) left.push("0");
    return left.concat(right).map(function (v) { return parseInt(v, 16); });
  }
  function isLocalHost(input) {
    var host = input.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (host.indexOf(":") >= 0) {
      var v = ipv6Words(host); if (!v) return false;
      if (v.slice(0, 7).every(function (n) { return n === 0; }) && v[7] <= 1) return true;
      if ((v[0] & 0xfe00) === 0xfc00 || (v[0] & 0xffc0) === 0xfe80) return true;
      if (v.slice(0, 5).every(function (n) { return n === 0; }) && v[5] === 0xffff) return isLocalHost((v[6] >> 8) + "." + (v[6] & 255) + "." + (v[7] >> 8) + "." + (v[7] & 255));
      return false;
    }
    if (host === "localhost" || /\.localhost$|\.local$/.test(host)) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      var n = host.split(".").map(Number);
      if (n.some(function (v) { return v > 255; })) return false;
      return n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] === 169 && n[1] === 254 || n[0] === 192 && n[1] === 168 || n[0] === 172 && n[1] >= 16 && n[1] <= 31;
    }
    return host.indexOf(".") < 0;
  }
  function normalizeHost(value) {
    assert(typeof value === "string", "主机必须是文本");
    let host = value.trim().toLowerCase().replace(/\.$/, "");
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    assert(!/[\[\]]/.test(host), "IP 地址括号不完整");
    assert(host.length > 0 && host.length <= 253 && !/[\s/\\;\"'@?#%]/.test(host), "主机只能填写 IP 或域名，不能包含协议、路径、端口或特殊字符");
    if (host.includes(":")) {
      assert(!/^[^:]+:\d+$/.test(host), "主机不能包含端口，请把端口填到“端口”栏");
      assert(ipv6Words(host), "IPv6 地址无效");
    }
    else if (/^[0-9.]+$/.test(host)) assert(/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split(".").every(v => +v <= 255 && (v === "0" || !v.startsWith("0"))), "IPv4 地址无效");
    else assert(host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)), "域名无效（国际域名请使用 Punycode）");
    return host;
  }
  function profile(raw) {
    assert(raw && typeof raw === "object" && !Array.isArray(raw), "代理配置无效");
    assert(raw.scheme === "http" || raw.scheme === "socks5", "协议只支持 HTTP 或 SOCKS5");
    assert(typeof raw.port === "number" || typeof raw.port === "string" && /^\d+$/.test(raw.port.trim()), "端口必须是整数");
    const port = Number(raw.port);
    assert(Number.isInteger(port) && port >= 1 && port <= 65535, "端口必须是 1～65535 的整数");
    assert(typeof raw.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(raw.id), "配置 ID 无效");
    assert(typeof raw.name === "string" && raw.name.trim().length > 0 && raw.name.length <= 100, "名称长度应为 1～100 字符");
    return { id: raw.id, name: raw.name.trim(), scheme: raw.scheme, host: normalizeHost(raw.host), port };
  }
  function config(raw) {
    raw = raw || {};
    const c = { ...DEFAULTS, ...raw, float: { ...DEFAULTS.float, ...(raw.float || {}) } };
    // Migrate old profiles without opting users into silent DIRECT fallback.
    assert(typeof c.enabled === "boolean" && typeof c.allowDirectFallback === "boolean", "代理开关必须是布尔值");
    assert(["global", "pac"].includes(c.mode), "代理模式无效");
    assert(["direct", "system"].includes(c.routing), "关闭后的路由策略无效");
    assert(["light", "dark", "neon"].includes(c.theme), "主题无效");
    assert(Array.isArray(c.profiles) && c.profiles.length > 0 && c.profiles.length <= 100, "至少保留一组配置，最多 100 组");
    c.profiles = c.profiles.map(profile);
    assert(new Set(c.profiles.map(p => p.id)).size === c.profiles.length, "配置 ID 重复");
    if (!c.profiles.some(p => p.id === c.activeId)) c.activeId = c.profiles[0].id;
    assert(Array.isArray(c.directDomains) && c.directDomains.length <= 1000, "直连域名列表无效");
    c.directDomains = [...new Set(c.directDomains.map(domain => { const d = normalizeHost(domain); assert(!d.includes(":"), "直连列表只接受域名"); return d; }))];
    assert(typeof c.float.enabled === "boolean" && typeof c.float.mini === "boolean", "悬浮窗开关无效");
    for (const axis of ["x", "y"]) assert(c.float[axis] === null || Number.isFinite(c.float[axis]) && c.float[axis] >= 0 && c.float[axis] <= 100000, "悬浮窗坐标无效");
    return c;
  }
  // 0.4.x saved profiles without validation. Drop invalid ones only when they cannot affect the
  // current route; an invalid in-use profile still throws so a user must choose direct/release.
  function repair(raw) {
    raw = raw || {};
    if (!Array.isArray(raw.profiles)) return { config: config(raw), removed: [] };
    const activeId = raw.activeId === undefined ? DEFAULTS.activeId : raw.activeId;
    const found = raw.profiles.findIndex(p => p?.id === activeId), activeIndex = found >= 0 ? found : 0;
    const kept = [], removed = [];
    raw.profiles.forEach((p, i) => {
      try { kept.push(profile(p)); }
      catch (error) {
        if (raw.enabled === true && i === activeIndex) throw new Error("当前使用的代理配置无效：" + error.message + "。请点击“强制直连”或“释放设置”，无效配置会被移除");
        const text = v => v === undefined || v === null ? "" : String(v).slice(0, 100);
        removed.push({ name: text(p?.name), host: text(p?.host), port: text(p?.port), error: error.message });
      }
    });
    if (!kept.length && raw.enabled !== true) kept.push(...DEFAULTS.profiles);
    return { config: config({ ...raw, profiles: kept }), removed };
  }
  function buildPacScript(cfg) {
    const p = cfg.profiles.find(p => p.id === cfg.activeId), host = p.host.includes(":") ? "[" + p.host + "]" : p.host;
    const proxy = (p.scheme === "socks5" ? "SOCKS5 " : "PROXY ") + host + ":" + p.port + (cfg.allowDirectFallback ? "; DIRECT" : "");
    return ipv6Words.toString() + "\n" + isLocalHost.toString() + "\nfunction FindProxyForURL(url, host) {\n" +
      "host = host.toLowerCase().replace(/\\.$/, '');\nif (isLocalHost(host)) return 'DIRECT';\nvar direct = " + JSON.stringify(cfg.directDomains) + ";\n" +
      "for (var i=0;i<direct.length;i++) if(host===direct[i] || host.slice(-(direct[i].length+1))==='.'+direct[i]) return 'DIRECT';\n" +
      "return " + JSON.stringify(proxy) + ";\n}";
  }
  function buildProxyValue(cfg) {
    if (!cfg.enabled) return cfg.routing === "direct" ? { mode: "direct" } : null;
    const p = cfg.profiles.find(p => p.id === cfg.activeId);
    if (cfg.mode === "pac") return { mode: "pac_script", pacScript: { data: buildPacScript(cfg), mandatory: true } };
    return { mode: "fixed_servers", rules: { singleProxy: { scheme: p.scheme, host: p.host, port: p.port }, bypassList: ["localhost", "*.localhost", "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "[::1]", "[fc00::]/7", "[fe80::]/10", "*.local", "<local>"] } };
  }
  function stable(value) {
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
    return JSON.stringify(value);
  }
  function sameProxy(a, b) {
    if (!a || !b || a.mode !== b.mode) return false;
    if (a.mode === "direct" || a.mode === "system") return true;
    if (a.mode === "pac_script") return a.pacScript?.data === b.pacScript?.data && !!a.pacScript?.mandatory === !!b.pacScript?.mandatory;
    if (a.mode === "fixed_servers") {
      const p = a.rules?.singleProxy, q = b.rules?.singleProxy;
      return !!p && !!q && p.host === q.host && p.port === q.port && p.scheme === q.scheme && stable([...(a.rules.bypassList || [])].sort()) === stable([...(b.rules.bypassList || [])].sort());
    }
    return stable(a) === stable(b);
  }
  function stats(samples) {
    const valid = samples.filter(Number.isFinite), current = Number.isFinite(samples[samples.length - 1]) ? samples[samples.length - 1] : null;
    let sum = 0, pairs = 0;
    for (let i = 1; i < samples.length; i++) if (Number.isFinite(samples[i - 1]) && Number.isFinite(samples[i])) { sum += Math.abs(samples[i] - samples[i - 1]); pairs++; }
    return { current, avg: valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0, jitter: pairs ? Math.round(sum / pairs) : null, valid };
  }
  function status(c, setting, health, key, proxyError) {
    if (["controlled_by_other_extensions", "not_controllable"].includes(setting.levelOfControl)) return { code: "taken_over", label: "被接管／不可控", good: false };
    const desired = buildProxyValue(c);
    if (desired && (!sameProxy(desired, setting.value) || setting.levelOfControl !== "controlled_by_this_extension")) return { code: "mismatch", label: "设置未生效", good: false };
    if (!desired && setting.levelOfControl === "controlled_by_this_extension") return { code: "mismatch", label: "代理尚未释放", good: false };
    if (!c.enabled) return { code: c.routing, label: c.routing === "direct" ? "强制直连" : "跟随系统", good: false };
    if (proxyError) return { code: "proxy_error", label: "代理报错", good: false };
    if (!health || health.routeKey !== key || Date.now() - health.at > 7500) return { code: "unverified", label: "代理已启用·待验证", good: false };
    return health.ok ? { code: "reachable", label: c.mode === "pac" && c.allowDirectFallback ? "HTTP 可达·可回退" : "HTTP 可达", good: true } : { code: "failed", label: "链路检测失败", good: false };
  }
  const api = { DEFAULTS, config, repair, profile, normalizeHost, ipv6Words, isLocalHost, buildPacScript, buildProxyValue, sameProxy, stable, stats, status };
  root.ProxyCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
