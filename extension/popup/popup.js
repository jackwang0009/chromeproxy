const $ = (id) => document.getElementById(id);
const MAX = 40; // 图表保留的采样点数
const INTERVAL = 1500; // 采样间隔(ms)
const THEMES = ["light", "dark", "neon"];
const THEME_LABELS = { dark: "暗色", light: "亮色", neon: "霓虹" };

let state = null;
let samples = []; // 每项为延迟 ms，超时/失败记为 null
let sampling = false;
let samplingTimer = null;
let runtimeStatus = null;
let renderedProfiles = null;

$("version").textContent = "v" + chrome.runtime.getManifest().version;
function send(message) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      resolve(error ? { ok: false, error: error.message } : response || { ok: false, error: "后台未返回结果" });
    }); } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}
function accept(result, profiles = false) {
  if (!result || !result.ok) { showMsg(result?.error || "操作失败", "err"); return false; }
  if (result.config) state = result.config;
  if (result.status) {
    if (runtimeStatus && result.routeKey !== runtimeStatus.routeKey) {
      samples = []; renderMonitor();
      $("egress").textContent = "待刷新"; $("isp").textContent = ""; $("landingResult").textContent = "";
    }
    runtimeStatus = result;
  }
  if (state) {
    applyTheme(state.theme); renderMode(); renderStatus(); renderNotice(); renderFloat();
    // 重绘列表会重置编辑表单，所以只在要求时或列表变化时重绘，定时刷新不会覆盖正在编辑的内容
    const key = ProxyCore.stable([state.profiles, state.activeId]);
    if (profiles || key !== renderedProfiles) { renderedProfiles = key; renderProfiles(); }
  }
  return true;
}

function showMsg(text, kind) {
  const m = $("msg");
  m.textContent = text || "";
  m.className = "msg " + (kind || "");
}

function applyTheme(t) {
  const theme = THEMES.includes(t) ? t : "light";
  document.documentElement.dataset.theme = theme;
  $("themeLabel").textContent = THEME_LABELS[theme];
}

/* ---------- 状态渲染 ---------- */

function renderStatus() {
  const pill = $("status"), status = runtimeStatus?.status;
  pill.textContent = status?.label || (state?.enabled ? "代理已启用·待验证" : "待检查");
  pill.className = "pill " + (status?.good ? "on" : ["failed", "proxy_error", "mismatch", "taken_over"].includes(status?.code) ? "error" : state?.enabled ? "warn" : "off");
  $("allowFallback").checked = !!state?.allowDirectFallback;
  $("allowFallback").disabled = state?.mode !== "pac";
  const health = runtimeStatus?.health;
  const stamp = health ? new Date(health.at).toLocaleTimeString([], { hour12: false }) : "";
  const details = {
    direct: "当前浏览器已显式直连，系统代理设置保持不变。",
    system: "已释放设置，实际路由由系统或其他代理决定。",
    taken_over: "其他扩展或管理策略正在控制浏览器代理。",
    mismatch: "保存配置与实际设置不同，请重新应用或释放设置。",
    unverified: "尚无当前线路的有效检测，点击“检测链路”验证。",
    reachable: "最近检测 " + stamp + " · HTTPS 请求成功",
    failed: "最近检测失败 · " + (health?.error || "请检查 Clash 与端口"),
    proxy_error: runtimeStatus?.lastProxyError?.error || "代理报错，请检查上游配置。"
  };
  $("healthDetail").textContent = details[status?.code] || "正在读取浏览器代理设置…";
  $("healthDetail").title = "HTTP 可达不代表节点身份或所有网站可访问。" + (health?.error || "");
}

// 旧版本保存的无效配置在升级时被移除，提示保留到用户点击关闭
function renderNotice() {
  const removed = runtimeStatus?.configNotice || [];
  $("notice").textContent = removed.length ? "已移除无效的旧代理配置：" + removed.map(r =>
    `「${r.name || "未命名"}」（主机 ${r.host || "空"}，端口 ${r.port || "空"}）：${r.error}`).join("；") + "。如需使用请重新添加。点击关闭" : "";
}

function renderMode() {
  const enabled = !!state?.enabled;
  document.querySelectorAll(".mode").forEach(button => {
    const active = enabled && button.dataset.mode === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll(".disc").forEach(button => {
    const active = runtimeStatus?.status?.code === "direct";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
    button.disabled = active;
  });
}

function renderProfiles() {
  const sel = $("profile");
  sel.innerHTML = "";
  for (const p of state.profiles) {
    const o = document.createElement("option");
    o.value = p.id;
    const host = p.host.includes(":") ? `[${p.host}]` : p.host;
    o.textContent = `${p.name} · ${host}:${p.port}`;
    o.title = `${p.scheme.toUpperCase()}://${host}:${p.port}`;
    sel.appendChild(o);
  }
  sel.value = state.activeId;
  fillManage();
}

function fillManage() {
  const p = state.profiles.find((x) => x.id === state.activeId) || state.profiles[0];
  if (!p) return;
  $("pname").value = p.name;
  $("scheme").value = p.scheme;
  $("host").value = p.host;
  $("port").value = p.port;
}

function renderFloat() {
  const on = !!(state && state.float && state.float.enabled);
  $("floatLabel").textContent = "网页悬浮窗：" + (on ? "开" : "关");
  $("floatToggle").classList.toggle("primary", on);
  $("floatToggle").setAttribute("aria-pressed", String(on));
}

async function refreshState(full = true) {
  const r = await send({ type: "getState" });
  accept(r, full);
}

async function reloadBeforeEdit() {
  await refreshState();
  if (state) showMsg("配置已重新加载，请确认后再操作。", "err");
}

/* ---------- 出口 IP ---------- */

async function refreshEgress() {
  $("egress").textContent = "获取中…";
  $("isp").textContent = "";
  const r = await send({ type: "egress" });
  if (r?.routeKey && r.routeKey !== runtimeStatus?.routeKey) return;
  if (r && r.ok) {
    const loc = [r.country, r.city].filter(Boolean).join(" ");
    $("egress").textContent = (loc ? loc + " · " : "") + r.ip;
    $("isp").textContent = r.isp ? "ISP：" + r.isp : "";
  } else {
    $("egress").textContent = "未知";
    $("isp").textContent = r?.error || "";
  }
  $("isp").classList.toggle("failure", !(r && r.ok));
}

/* ---------- 网络监控采样 ---------- */

async function sampleOnce() {
  const r = await send({ type: "sample" });
  // A fresh probe writes health, and storage.onChanged below refreshes state for it.
  if (!r?.ok || r.cached) await refreshState(false);
  if (r?.ok && r.routeKey === runtimeStatus?.routeKey) { samples = r.samples; renderMonitor(); }
}

function startSampling() {
  if (sampling) return;
  sampling = true;
  const loop = async () => { if (!sampling) return; try { await sampleOnce(); } finally { if (sampling) samplingTimer = setTimeout(loop, INTERVAL); } };
  loop();
}
window.addEventListener("pagehide", () => { sampling = false; clearTimeout(samplingTimer); });

function renderMonitor() {
  const { current, avg, jitter, valid } = ProxyCore.stats(samples);
  $("latency").textContent = current == null ? "--" : current;
  $("jitter").textContent = jitter == null ? "--" : jitter;

  const deltaEl = $("delta");
  if (current == null || valid.length < 3) {
    deltaEl.textContent = "";
    deltaEl.className = "delta";
  } else {
    const d = Math.round(current - avg);
    const good = d <= 0;
    deltaEl.textContent = `较均值 ${d > 0 ? "+" : ""}${d} ms`;
    deltaEl.className = "delta " + (good ? "good" : "bad");
  }

  const failed = samples.filter(value => value == null).length;
  $("sampleFailures").textContent = failed ? ` · 失败 ${failed}` : "";
  drawChart(valid);
}

// Monotone cubic interpolation: passes through every measurement, without
// averaging samples or overshooting extrema. Each failure-separated run is independent.
function chartTangents(points) {
  if (points.length < 2) return points.map(() => 0);
  const d = points.slice(1).map((p, i) => p.y - points[i].y);
  return points.map((_p, i) => {
    if (i === 0) return d[0];
    if (i === points.length - 1) return d[d.length - 1];
    const a = d[i - 1], b = d[i];
    return a * b <= 0 ? 0 : 2 * a * b / (a + b);
  });
}
function traceChartRun(ctx, points, slopes) {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = (b.x - a.x) / 3;
    ctx.bezierCurveTo(a.x + dx, a.y + slopes[i - 1] / 3,
      b.x - dx, b.y - slopes[i] / 3, b.x, b.y);
  }
}

function drawChart(valid) {
  const c = $("chart");
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || 260;
  const cssH = 56;
  c.width = Math.round(cssW * dpr);
  c.height = Math.round(cssH * dpr);
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const cs = getComputedStyle(document.documentElement);
  const lineColor = (cs.getPropertyValue("--chart-line") || "#2ee6c5").trim();
  const gridColor = (cs.getPropertyValue("--chart-grid") || "rgba(255,255,255,0.06)").trim();
  const fillTop = (cs.getPropertyValue("--chart-fill-top") || "rgba(46,230,197,0.45)").trim();
  const fillBottom = (cs.getPropertyValue("--chart-fill-bottom") || "rgba(46,230,197,0.02)").trim();

  const maxVal = Math.max(100, ...valid);
  const niceMax = Math.ceil(maxVal / 20) * 20;
  $("yMax").textContent = niceMax + "ms";
  $("yMid").textContent = Math.round(niceMax / 2) + "ms";

  // 网格中线
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, cssH / 2);
  ctx.lineTo(cssW, cssH / 2);
  ctx.stroke();

  const n = samples.length;
  if (n === 0) return;
  const stepX = cssW / (MAX - 1);
  const xOf = (i) => cssW - (n - 1 - i) * stepX;
  const yOf = (v) => {
    const y = cssH * (1 - v / niceMax);
    return Math.max(2, Math.min(cssH - 2, y));
  };

  // 面积（把每段有效点连起来，null 作为断点）
  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, fillTop);
  grad.addColorStop(1, fillBottom);

  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let seg = [];
  const flush = () => {
    if (seg.length === 0) return;
    if (seg.length === 1) {
      ctx.beginPath();
      ctx.arc(seg[0].x, seg[0].y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
      seg = [];
      return;
    }
    const slopes = chartTangents(seg);
    ctx.beginPath();
    ctx.moveTo(seg[0].x, cssH);
    ctx.lineTo(seg[0].x, seg[0].y);
    traceChartRun(ctx, seg, slopes);
    ctx.lineTo(seg[seg.length - 1].x, cssH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(seg[0].x, seg[0].y);
    traceChartRun(ctx, seg, slopes);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    seg = [];
  };
  const failures = [];
  for (let i = 0; i < n; i++) {
    if (samples[i] == null) { flush(); failures.push(xOf(i)); continue; }
    seg.push({ x: xOf(i), y: yOf(samples[i]) });
  }
  flush();
  // A failed HTTP probe has no latency value. Mark its position, never plot zero.
  if (failures.length) {
    ctx.beginPath();
    for (const x of failures) {
      const markerX = Math.max(2, Math.min(cssW - 2, x));
      ctx.moveTo(markerX, cssH - 5);
      ctx.lineTo(markerX, cssH - 1.5);
    }
    ctx.strokeStyle = (cs.getPropertyValue("--warn") || "#b97520").trim();
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
}

/* ---------- 事件绑定 ---------- */

$("modes").addEventListener("click", async e => {
  const disc = e.target.closest(".disc"), mode = e.target.closest(".mode");
  if (!disc && !mode || disc?.disabled) return;
  const r = await send(disc ? { type: "disconnect" } : { type: "connect", mode: mode.dataset.mode });
  if (accept(r)) {
    showMsg(disc ? "已显式设置当前浏览器直连。" : "代理配置已启用，正在验证 HTTP 链路。", "ok");
    refreshEgress(); sampleOnce();
  } else await refreshState(false);
});
$("releaseProxy").addEventListener("click", async () => {
  if (accept(await send({ type: "releaseProxy" }))) { showMsg("已释放本扩展设置；实际联网方式由系统／其他配置决定。", "ok"); refreshEgress(); }
});
$("allowFallback").addEventListener("change", async () => {
  const enabled = $("allowFallback").checked;
  if (enabled && !window.confirm("允许代理失败时直连，可能暴露真实出口 IP。确定开启？")) { $("allowFallback").checked = false; return; }
  if (!accept(await send({ type: "setFallback", enabled }))) await refreshState(false);
});
$("profile").addEventListener("change", async () => {
  const r = await send({ type: "selectProfile", id: $("profile").value });
  if (accept(r, true)) { showMsg("已应用代理配置；Clash 内部节点仍需在 Clash 中选择。", "ok"); refreshEgress(); sampleOnce(); }
  else await refreshState(true);
});

$("manageBtn").addEventListener("click", () => {
  const open = $("manage").classList.contains("hidden");
  $("manage").classList.toggle("hidden", !open);
  $("manageBtn").setAttribute("aria-expanded", String(open));
  if (open) $("manage").scrollIntoView({ block: "nearest" });
});

$("saveProfile").addEventListener("click", async () => {
  if (!state) return reloadBeforeEdit();
  const profile = {
    id: state.activeId,
    name: $("pname").value,
    scheme: $("scheme").value,
    host: $("host").value,
    port: $("port").value
  };
  const r = await send({ type: "saveProfile", profile });
  if (accept(r, true)) { showMsg("已保存并应用代理配置", "ok"); refreshEgress(); sampleOnce(); }
});

$("newProfile").addEventListener("click", async () => {
  const r = await send({
    type: "saveProfile",
    profile: { name: "新节点", scheme: "http", host: "127.0.0.1", port: 7897 }
  });
  if (accept(r, true)) { $("manage").classList.remove("hidden"); $("manageBtn").setAttribute("aria-expanded", "true"); $("manage").scrollIntoView({ block: "nearest" }); showMsg("已新增并选中代理配置，请编辑后保存。", "ok"); refreshEgress(); sampleOnce(); }
});

$("deleteProfile").addEventListener("click", async () => {
  if (!state) return reloadBeforeEdit();
  const r = await send({ type: "deleteProfile", id: state.activeId });
  if (accept(r, true)) { showMsg("已删除代理配置", "ok"); refreshEgress(); sampleOnce(); }
});

$("test").addEventListener("click", async () => {
  showMsg("测试中…");
  const t = await send({ type: "test" });
  showMsg(t.ok ? `HTTP 请求成功（${t.ms}ms，不是 Ping）` : `测试失败：${t.error || "无法连通"}`, t.ok ? "ok" : "err");
  await refreshState(false);
});

$("refreshIp").addEventListener("click", refreshEgress);
$("notice").addEventListener("click", async () => { accept(await send({ type: "dismissNotice" })); });

$("landing").addEventListener("click", async () => {
  const res = $("landingResult");
  res.className = "landing-result";
  res.textContent = "检测中…（按当前浏览器路由；不进行播放验证）";
  const r = await send({ type: "landing" });
  if (!r || !r.ok) {
    res.className = "landing-result err";
    res.textContent = "检测失败，请重试";
    return;
  }
  if (r.routeKey !== runtimeStatus?.routeKey) { res.textContent = "线路已变化，请重新检测。"; return; }
  const yt = r.youtube?.ok ? "YouTube 页面地区：" + (r.youtube.region || "未识别") : "YouTube 页面检测失败";
  const accessible = r.netflix?.pages?.filter(p => p.accessible).length || 0;
  res.className = "landing-result";
  res.textContent = yt + " ｜ Netflix 样本页面可访问 " + accessible + "/2。仅供参考，未验证播放、订阅或解锁；失败不等于不支持。";
});

$("floatToggle").addEventListener("click", async () => {
  const on = !!(state && state.float && state.float.enabled);
  const r = await send({ type: "setFloat", enabled: !on });
  if (accept(r)) {
    renderFloat();
    showMsg(!on ? "已开启网页悬浮窗，去任意网页看看。" : "已关闭网页悬浮窗。", "ok");
  }
});

$("theme").addEventListener("click", async () => {
  const cur = (state && state.theme) || document.documentElement.dataset.theme || "light";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  applyTheme(next);
  const r = await send({ type: "setTheme", theme: next });
  accept(r);
  renderMonitor(); // 用新主题颜色重绘图表
});

/* ---------- 启动 ---------- */

document.addEventListener("DOMContentLoaded", async () => {
  await refreshState();
  refreshEgress();
  // 先恢复已持久化的历史，图表续跑而不是从零重来
  const r = await send({ type: "getSamples" });
  if (r && r.ok) {
    samples = r.samples;
    renderMonitor();
  }
  startSampling();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.monitor) {
    const monitor = changes.monitor.newValue;
    samples = monitor?.routeKey === runtimeStatus?.routeKey ? monitor.samples : [];
    renderMonitor();
  }
  if (changes.egress && !changes.egress.newValue) { $("egress").textContent = "待刷新"; $("isp").textContent = ""; }
  if (changes.config || changes.health || changes.proxyError) refreshState(false);
});
