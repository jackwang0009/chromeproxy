// 网页悬浮窗：在页面上叠加可拖动的小浮层，显示 代理状态 / 模式 / 延迟 / 抖动 / 节点·地区。
// 点击浮层可循环切换模式；迷你模式仅显示延迟；探测由后台执行以绕开网页 CSP。
(() => {
  const PROBE_INTERVAL = 1500;

  let host = null;
  let shadow = null;
  let samples = [];
  let timer = null;
  let cfg = { enabled: false, mode: "global", activeId: "", profiles: [], float: { enabled: false, x: null, y: null, mini: false } };
  let egress = null;
  let runtimeState = null;
  let ticking = false;

  const send = (m) => chrome.runtime.sendMessage(m);

  function readFloat(c) {
    return { enabled: false, x: null, y: null, mini: false, ...(c && c.float ? c.float : {}) };
  }
  const floatEnabled = (c) => readFloat(c).enabled === true;

  async function loadState() {
    try {
      const result = await send({ type: "getState" });
      if (!result?.ok) return;
      if (runtimeState?.routeKey !== result.routeKey) samples = [];
      runtimeState = result;
      cfg = result.config;
      cfg.float = readFloat(cfg);
      egress = result.egress || null;
    } catch (_) {}
  }

  const el = (id) => (shadow ? shadow.getElementById(id) : null);

  function createOverlay() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;left:auto;margin:0;padding:0;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>" +
      ".box{display:inline-flex;align-items:center;gap:7px;box-sizing:border-box;" +
      "font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif;line-height:normal;" +
      "background:rgba(14,23,48,0.92);color:#eaf1ff;border:1px solid rgba(255,255,255,0.12);" +
      "border-radius:999px;padding:6px 10px;box-shadow:0 6px 20px rgba(0,0,0,0.35);" +
      "font-size:12px;cursor:grab;user-select:none;-webkit-user-select:none;white-space:nowrap;}" +
      ".box.drag{cursor:grabbing;}" +
      ".dot{width:8px;height:8px;border-radius:50%;background:#64748b;flex:0 0 auto;}" +
      ".dot.on{background:#22c55e;box-shadow:0 0 6px #22c55e;}" +
      ".seg{color:#8ba0c8;}" +
      ".seg b{font-size:14px;font-weight:800;color:#eaf1ff;}" +
      ".u{color:#8ba0c8;margin-left:2px;font-size:10px;}" +
      ".mode{color:#2ee6c5;font-weight:700;}" +
      ".meta{color:#8ba0c8;max-width:180px;overflow:hidden;text-overflow:ellipsis;}" +
      ".ic{color:#8ba0c8;cursor:pointer;font-size:14px;line-height:1;padding:0 3px;}" +
      ".ic:hover{color:#eaf1ff;}" +
      "#close:hover{color:#f87171;}" +
      ".box.mini .fullonly{display:none;}" +
      "</style>" +
      '<div class="box" id="box">' +
      '<span class="dot" id="dot"></span>' +
      '<span class="seg mode fullonly" id="mode">未连</span>' +
      '<span class="seg"><span class="fullonly">HTTP </span><b id="lat">--</b><span class="u">ms</span></span>' +
      '<span class="seg fullonly">波动 <b id="jit">--</b><span class="u">ms</span></span>' +
      '<span class="seg meta fullonly" id="meta"></span>' +
      '<span class="ic" id="mini" title="迷你 / 展开">\u2013</span>' +
      '<span class="ic" id="close" title="关闭悬浮窗">\u00d7</span>' +
      "</div>";
    (document.documentElement || document.body).appendChild(host);
    el("mini").addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      setMini(!(cfg.float && cfg.float.mini));
    });
    el("close").addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      setFloatEnabled(false);
    });
    setupDrag();
    applyPosition();
    render();
    // 拉一次最新出口信息
    send({ type: "egress" }).catch(() => {});
  }

  function destroyOverlay() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
    samples = [];
  }

  function applyPosition() {
    if (!host) return;
    const f = cfg.float || {};
    if (typeof f.x === "number" && typeof f.y === "number") {
      host.style.left = f.x + "px";
      host.style.top = f.y + "px";
      host.style.right = "auto";
    } else {
      host.style.right = "16px";
      host.style.left = "auto";
      host.style.top = "16px";
    }
  }

  function setupDrag() {
    const box = el("box");
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, active = false;
    box.addEventListener("pointerdown", (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      if (e.target.closest && e.target.closest(".ic")) return; // 按钮不触发拖动
      active = true;
      moved = false;
      const rect = host.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      sx = e.clientX;
      sy = e.clientY;
      box.classList.add("drag");
      try { box.setPointerCapture(e.pointerId); } catch (_) {}
    });
    box.addEventListener("pointermove", (e) => {
      if (!active) return;
      if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 3) moved = true;
      const nx = ox + (e.clientX - sx);
      const ny = oy + (e.clientY - sy);
      host.style.left = Math.max(0, Math.min(window.innerWidth - host.getBoundingClientRect().width, nx)) + "px";
      host.style.top = Math.max(0, Math.min(window.innerHeight - host.getBoundingClientRect().height, ny)) + "px";
      host.style.right = "auto";
    });
    const end = (e) => {
      if (!active || !e.isTrusted) return;
      active = false;
      box.classList.remove("drag");
      if (moved) {
        const rect = host.getBoundingClientRect();
        savePosition(Math.round(rect.left), Math.round(rect.top));
        return;
      }
      // 视为点击：切换模式（点在按钮上则由按钮处理）
      if (e.target.closest && e.target.closest(".ic")) return;
      cycleMode();
    };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", () => { active = false; box.classList.remove("drag"); });
  }

  function nodeName() {
    const p = (cfg.profiles || []).find((x) => x.id === cfg.activeId);
    return p ? p.name : "";
  }

  function regionText() {
    if (!egress || !egress.ip) return "";
    const parts = [];
    if (egress.country) parts.push(egress.country);
    if (egress.city) parts.push(egress.city);
    return parts.join(" ");
  }

  function render() {
    if (!host) return;
    const box = el("box");
    if (box) box.classList.toggle("mini", !!(cfg.float && cfg.float.mini));
    if (el("mini")) el("mini").textContent = cfg.float && cfg.float.mini ? "\u002b" : "\u2013";

    const dot = el("dot");
    if (dot) { dot.classList.toggle("on", !!runtimeState?.status?.good); dot.style.background = cfg.enabled && !runtimeState?.status?.good ? "#d97706" : ""; }
    const modeEl = el("mode");
    if (modeEl) { modeEl.textContent = runtimeState?.status?.label || "待检查"; modeEl.title = "HTTP 请求耗时，不是 Ping；点击依次切换全局、分流、强制直连"; }

    const { current, jitter } = ProxyCore.stats(samples);
    if (el("lat")) el("lat").textContent = current == null ? "--" : current;
    if (el("jit")) el("jit").textContent = jitter == null ? "--" : jitter;

    const meta = el("meta");
    if (meta) {
      const bits = [];
      const n = nodeName();
      const rg = regionText();
      if (n) bits.push(n);
      if (rg) bits.push(rg);
      meta.textContent = bits.join(" · ");
      meta.style.display = bits.length ? "" : "none";
    }
  }

  async function tick() {
    if (!host || ticking || document.visibilityState !== "visible") return;
    ticking = true;
    try {
      const result = await send({ type: "sample" });
      // A fresh probe writes health, and the storage listener below reloads state for it.
      if (!result?.ok || result.cached) await loadState();
      if (result?.ok && result.routeKey === runtimeState?.routeKey) samples = result.samples;
      render();
    } catch (_) {} finally { ticking = false; }
  }
  function startLoop() {
    if (timer) return;
    const loop = async () => { await tick(); if (host) timer = setTimeout(loop, PROBE_INTERVAL); };
    timer = setTimeout(loop, 0);
  }
  async function cycleMode() {
    try {
      const result = await send({ type: "cycleMode" });
      if (!result?.ok) { if (el("mode")) { el("mode").textContent = "切换失败"; el("mode").title = result?.error || "后台不可用"; } return; }
      await loadState(); render();
      send({ type: "egress" }).then(() => loadState()).then(render).catch(() => {});
    } catch (_) {}
  }
  async function updateFloat(patch) {
    try {
      const result = await send({ type: "setFloatOptions", patch });
      if (result?.ok) { cfg = result.config; sync(); }
    } catch (_) {}
  }
  function setFloatEnabled(enabled) { return updateFloat({ enabled }); }
  function setMini(mini) { return updateFloat({ mini }); }
  function savePosition(x, y) { return updateFloat({ x, y }); }

  function sync() {
    if (cfg.float && cfg.float.enabled) {
      createOverlay();
      startLoop();
      applyPosition();
      render();
    } else {
      destroyOverlay();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.monitor) {
      const monitor = changes.monitor.newValue;
      samples = monitor?.routeKey === runtimeState?.routeKey ? monitor.samples : [];
      render();
    }
    // Without an overlay only config matters (it may enable one); reacting to health/error writes
    // here made every open tab query the worker on each probe and proxy error. Config writes that
    // leave the overlay off (theme, mode) are read here so they do not wake the worker either.
    if (changes.config && (host || floatEnabled(changes.config.newValue)) || host && (changes.egress || changes.health || changes.proxyError)) loadState().then(sync);
  });
  window.addEventListener("resize", () => {
    if (!host) return;
    const rect = host.getBoundingClientRect();
    host.style.left = Math.max(0, Math.min(window.innerWidth - rect.width, rect.left)) + "px";
    host.style.top = Math.max(0, Math.min(window.innerHeight - rect.height, rect.top)) + "px";
    host.style.right = "auto";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tick();
  });

  // The overlay is off by default. Read the flag from storage first so ordinary page loads do not
  // message (and wake) the service worker; the worker still validates everything it returns.
  (async () => {
    try {
      const { config } = await chrome.storage.local.get("config");
      if (!floatEnabled(config)) return;
    } catch (_) { return; }
    await loadState();
    sync();
  })();
})();
