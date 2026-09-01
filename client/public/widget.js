/**
 * HyAgent 嵌入式聊天 widget（POC）。
 *
 * 第三方網站只要加一行即可接入：
 *   <script src="https://<你的網域>/widget.js"></script>
 *
 * 載入後在右下角注入一顆浮動按鈕，點擊彈出聊天視窗（iframe 載入 OA panel 的 ?embed=1 模式）。
 * 純 vanilla JS、零依賴、樣式全用 inline + 唯一 id 命名，避免污染宿主頁面。
 */
(function () {
  "use strict";

  // 同一頁重複載入時只初始化一次
  if (window.__oaAgentWidgetLoaded) return;
  window.__oaAgentWidgetLoaded = true;

  // panel 來源網域＝widget.js 自己的來源（換正式網域時零修改）
  // currentScript 在某些載入情境（async/module/被搬移）可能為 null，退回用 src 比對找回自己
  var script =
    document.currentScript ||
    (function () {
      var all = document.getElementsByTagName("script");
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf("widget.js") !== -1) return all[i];
      }
      return null;
    })();
  if (!script) {
    console.error("[oa-agent] 找不到 widget script 標籤，無法初始化");
    return;
  }
  var origin = new URL(script.src).origin;
  // API 來源：預設＝載入 widget.js 的網域（單一網域同時供 SPA 與 API 時適用）。
  // 前後端分開部署（client 與 server 不同網域）時，務必以 data-api 指向 server 對外網址，
  // 例：data-api="https://hyagent-server.zeabur.app"，否則 config 會打到靜態 client 網域而失敗。
  var apiBase = (function () {
    var v = script.getAttribute("data-api");
    return v && v.trim() ? v.trim().replace(/\/+$/, "") : origin;
  })();

  // ---- 可選設定（全部 data-*，未帶則維持預設，向後相容）----
  //   data-title       浮動按鈕文案
  //   data-key         租戶公開金鑰 pk_…（多租戶資料隔離；不帶則後端落到預設租戶）
  //   data-form        預選表單類型，如 leave-request
  //   data-locale      介面語言，如 zh-Hant / en
  //   data-theme       外觀 light / dark
  //   data-position    浮動按鈕位置 right（預設）/ left
  //   data-offset-x    距側邊距離（px，預設 20）
  //   data-offset-y    距底部距離（px，預設 20；調高可避開頁面既有的 go-to-top 按鈕）
  //   data-user-token  SSO handoff：宿主簽發的終端使用者 token（免內部帳密登入）
  function attr(name) {
    var v = script.getAttribute(name);
    return v && v.trim() ? v.trim() : null;
  }
  // 啟動按鈕文字優先序：data-title（宿主明確覆寫）> 租戶後台 AI 名稱（稍後 async 補上）> 預設
  var explicitTitle = attr("data-title");
  var title = explicitTitle || "OA 小幫手";
  // 宿主明確指定的主題／位置（data-*）；有指定就優先，後端外觀不再覆寫。
  var explicitTheme = attr("data-theme");
  var explicitPosition = attr("data-position");
  var position = explicitPosition === "left" ? "left" : "right";
  // 啟動按鈕距邊距（px）：宿主 data-offset-x/y 優先，否則稍後採後端 appearance；預設 20。
  // offsetY 調高可把按鈕往上抬，避開宿主頁既有的 go-to-top 等按鈕。
  function clampOffset(v) {
    var n = parseInt(v, 10);
    return isNaN(n) ? 20 : Math.max(0, Math.min(200, n));
  }
  var explicitOffsetX = attr("data-offset-x");
  var explicitOffsetY = attr("data-offset-y");
  var offsetX = explicitOffsetX !== null ? clampOffset(explicitOffsetX) : 20;
  var offsetY = explicitOffsetY !== null ? clampOffset(explicitOffsetY) : 20;
  // data-launcher="none"：不顯示預設浮動按鈕，由宿主自己的按鈕呼叫 OAAgent.open() 開啟
  var showLauncher = attr("data-launcher") !== "none";

  // 把設定組成 panel iframe 的 query；只附帶有值的參數
  var panelParams = ["embed=1"];
  var cfg = {
    key: attr("data-key"),
    form: attr("data-form"),
    locale: attr("data-locale"),
    theme: explicitTheme,
    userToken: attr("data-user-token"),
  };
  for (var ck in cfg) {
    if (cfg[ck]) panelParams.push(ck + "=" + encodeURIComponent(cfg[ck]));
  }
  var panelUrl = origin + "/?" + panelParams.join("&");

  var Z = 2147483000; // 盡量蓋在宿主頁面之上
  var open = false;
  var iframe = null; // 延遲建立：首次點開才載入，避免拖慢宿主頁

  // ---- 浮動按鈕樣式（注入 scoped <style>，僅作用於 widget 自身元素，不污染宿主頁）----
  // 參考宿主站 .ai-highlight 樣式：漸層底色、機器人跳動動畫、上線小綠點、hover 浮起放大＋標籤
  var STYLE_ID = "oa-agent-launcher-style";
  if (!document.getElementById(STYLE_ID)) {
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      "#oa-agent-launcher{",
      "position:fixed;right:20px;bottom:20px;",
      "width:56px;height:56px;border-radius:50%;border:none;outline:none;padding:0;margin:0;",
      "display:flex;align-items:center;justify-content:center;overflow:visible;",
      "color:#fff;cursor:pointer;",
      // 主色以 CSS 變數驅動（預設藍）；有租戶 primaryColor 時 JS 覆寫變數，hover/標籤一併跟著變
      "background:linear-gradient(135deg,var(--oa-primary-light,#5896f5) 0%,var(--oa-primary,#2563eb) 100%);",
      "box-shadow:0 4px 15px var(--oa-primary-shadow,rgba(37,99,235,.35));",
      "z-index:" + (Z + 1) + ";",
      "transition:transform .3s cubic-bezier(.175,.885,.32,1.275),box-shadow .3s ease;",
      "}",
      "#oa-agent-launcher:hover,#oa-agent-launcher:focus-visible{",
      "transform:translateY(-2px) scale(1.1);",
      "box-shadow:0 10px 25px var(--oa-primary-shadow-strong,rgba(37,99,235,.45));",
      "}",
      "#oa-agent-launcher .oa-agent-icon{",
      "width:34px;height:34px;display:block;will-change:transform;",
      "animation:oa-agent-hop 5s infinite;",
      "}",
      "#oa-agent-launcher:hover .oa-agent-icon,#oa-agent-launcher:focus-visible .oa-agent-icon{",
      "animation-play-state:paused;",
      "}",
      "#oa-agent-launcher .oa-agent-status{",
      "position:absolute;top:2px;right:2px;width:11px;height:11px;border-radius:50%;",
      "border:2px solid #fff;background:#4ade80;box-shadow:0 0 8px rgba(74,222,128,.6);",
      "}",
      "#oa-agent-launcher .oa-agent-label{",
      "position:absolute;right:calc(100% + 12px);top:50%;",
      "transform:translateY(-50%) translateX(10px);",
      "white-space:nowrap;padding:4px 12px;border-radius:12px;",
      "background:hsla(0,0%,100%,.98);color:var(--oa-primary,#2563eb);font-size:12px;font-weight:800;",
      "border:1px solid rgba(37,99,235,.1);box-shadow:0 6px 16px rgba(0,0,0,.12);",
      "opacity:0;visibility:hidden;pointer-events:none;",
      "transition:opacity .3s cubic-bezier(.165,.84,.44,1),transform .3s cubic-bezier(.165,.84,.44,1),visibility .3s;",
      "}",
      "#oa-agent-launcher:hover .oa-agent-label,#oa-agent-launcher:focus-visible .oa-agent-label{",
      "opacity:1;visibility:visible;transform:translateY(-50%) translateX(0);",
      "}",
      "@keyframes oa-agent-hop{",
      "0%,80%,100%{transform:translateY(0) rotate(0);}",
      "85%{transform:translateY(-5px) rotate(-8deg);}",
      "90%{transform:translateY(-7px) rotate(8deg);}",
      "95%{transform:translateY(-5px) rotate(0);}",
      "}",
    ].join("");
    document.head.appendChild(style);
  }

  // ---- 浮動按鈕 ----
  var btn = document.createElement("button");
  btn.id = "oa-agent-launcher";
  btn.type = "button";
  btn.setAttribute("aria-label", title);
  // 機器人 icon（inline 實心 SVG，避免依賴宿主頁的 Font Awesome；眼睛以 evenodd 鏤空透出底色）＋ 上線小綠點
  btn.innerHTML =
    '<svg class="oa-agent-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<circle cx="12" cy="2.6" r="1.5"/>' +
    '<rect x="11.25" y="3.6" width="1.5" height="2.2" rx="0.75"/>' +
    '<rect x="2" y="10" width="2" height="5" rx="1"/>' +
    '<rect x="20" y="10" width="2" height="5" rx="1"/>' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M7 5.5h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-7a3 3 0 0 1 3-3Zm2 5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/>' +
    "</svg>" +
    '<span class="oa-agent-status"></span>';
  // 標籤用 textContent 設定，避免 data-title 注入 HTML
  var label = document.createElement("span");
  label.className = "oa-agent-label";
  label.textContent = title;
  btn.appendChild(label);

  // 把 #rgb / #rrggbb 解析成 {r,g,b}；非法回 null
  function hexToRgb(h) {
    if (typeof h !== "string") return null;
    var m = h.trim().replace(/^#/, "");
    if (m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
    if (!/^[0-9a-fA-F]{6}$/.test(m)) return null;
    return {
      r: parseInt(m.slice(0, 2), 16),
      g: parseInt(m.slice(2, 4), 16),
      b: parseInt(m.slice(4, 6), 16),
    };
  }
  // 把租戶主色套到啟動按鈕：設 CSS 變數（漸層淺色端、陰影、標籤色一併連動）
  function applyPrimary(hex) {
    var c = hexToRgb(hex);
    if (!c) return;
    var light =
      "rgb(" +
      Math.round(c.r + (255 - c.r) * 0.28) +
      "," +
      Math.round(c.g + (255 - c.g) * 0.28) +
      "," +
      Math.round(c.b + (255 - c.b) * 0.28) +
      ")";
    var rgba = function (a) {
      return "rgba(" + c.r + "," + c.g + "," + c.b + "," + a + ")";
    };
    btn.style.setProperty("--oa-primary", hex);
    btn.style.setProperty("--oa-primary-light", light);
    btn.style.setProperty("--oa-primary-shadow", rgba(0.35));
    btn.style.setProperty("--oa-primary-shadow-strong", rgba(0.45));
  }

  // 向後端讀租戶後台外觀：AI 名稱（未設 data-title 時當按鈕文字）＋ 主色（套到啟動按鈕，與面板一致）。
  // 失敗（CORS / 離線 / 未設）則靜默維持預設，不影響啟動。
  if (cfg.key) {
    fetch(apiBase + "/api/widget/config?key=" + encodeURIComponent(cfg.key))
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (j) {
        var ap = j && j.data && j.data.appearance;
        if (!ap) return;
        if (!explicitTitle && ap.assistantName && ap.assistantName.trim()) {
          title = ap.assistantName.trim();
          label.textContent = title;
          btn.setAttribute("aria-label", title);
        }
        if (ap.primaryColor) applyPrimary(ap.primaryColor);
        // 位置與邊距：宿主未用 data-* 覆寫時，採用後端 appearance（bl→左下、br→右下；offset px）
        // theme 不在此處理：面板內 SPA 會自行套用租戶 theme，且尊重使用者在 widget 內的手動切換偏好。
        if (!explicitPosition && ap.position) {
          position = ap.position === "bl" ? "left" : "right";
        }
        if (explicitOffsetX === null && ap.offsetX != null)
          offsetX = clampOffset(ap.offsetX);
        if (explicitOffsetY === null && ap.offsetY != null)
          offsetY = clampOffset(ap.offsetY);
        applyPosition();
      })
      .catch(function () {});
  }

  // ---- 聊天彈窗容器 ----
  var panel = document.createElement("div");
  panel.id = "oa-agent-panel";
  panel.style.cssText = [
    "position:fixed",
    "right:20px",
    "bottom:88px",
    "width:400px",
    "height:640px",
    "max-width:calc(100vw - 40px)",
    "max-height:calc(100vh - 120px)",
    "border-radius:16px",
    "overflow:hidden",
    "box-shadow:0 12px 40px rgba(0,0,0,.3)",
    "background:#fff",
    "z-index:" + Z,
    "display:none",
    "opacity:0",
    "transform:translateY(8px)",
    "transition:opacity .15s ease, transform .15s ease",
  ].join(";");

  // 手機（窄螢幕）改為近全螢幕
  function applyMobile() {
    if (window.innerWidth <= 480) {
      panel.style.right = "0";
      panel.style.bottom = "0";
      panel.style.width = "100vw";
      panel.style.height = "100vh";
      panel.style.maxHeight = "100vh";
      panel.style.borderRadius = "0";
    }
  }
  applyMobile();
  window.addEventListener("resize", applyMobile);

  function setOpen(next) {
    open = next;
    if (open) {
      if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.src = panelUrl;
        iframe.title = title;
        iframe.style.cssText =
          "width:100%;height:100%;border:none;display:block;";
        panel.appendChild(iframe);
      }
      panel.style.display = "block";
      // 下一幀再做過場動畫
      requestAnimationFrame(function () {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0)";
      });
    } else {
      panel.style.opacity = "0";
      panel.style.transform = "translateY(8px)";
      setTimeout(function () {
        if (!open) panel.style.display = "none";
      }, 150);
    }
  }

  btn.addEventListener("click", function () {
    setOpen(!open);
  });

  // 啟動按鈕／面板定位：left 靠左下、right（預設）靠右下，並依 offsetX/offsetY 邊距擺放。
  // 抽成函式以便後端 appearance（position/offset）非同步回來時動態重套；pos 省略時沿用目前 position。
  function applyPosition(pos) {
    if (pos) position = pos === "left" ? "left" : "right";
    var left = position === "left";
    btn.style.left = left ? offsetX + "px" : "auto";
    btn.style.right = left ? "auto" : offsetX + "px";
    btn.style.bottom = offsetY + "px";
    // 面板：桌機依邊距定位（底部再往上讓開按鈕）；手機為全螢幕，由 applyMobile 處理、不套邊距
    if (window.innerWidth > 480) {
      panel.style.left = left ? offsetX + "px" : "auto";
      panel.style.right = left ? "auto" : offsetX + "px";
      panel.style.bottom = offsetY + 68 + "px";
    }
  }
  applyPosition(position);

  // panel 內聊天頁透過 postMessage 與宿主溝通：oa-agent:close 收起、oa-agent:submitted 已送出…
  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || typeof e.data.type !== "string")
      return;
    var type = e.data.type;
    if (type === "oa-agent:close") setOpen(false);
    // 轉發給宿主頁：DOM CustomEvent（window.addEventListener('oa-agent:submitted', …)）＋可選全域 callback
    try {
      window.dispatchEvent(new CustomEvent(type, { detail: e.data }));
    } catch (_e) {}
    if (window.OAAgent && typeof window.OAAgent.onEvent === "function") {
      try {
        window.OAAgent.onEvent(e.data);
      } catch (_e2) {}
    }
  });

  // 宿主頁可程式化控制：OAAgent.open() / close() / toggle()；onEvent 可在載入前先指定（保留之）
  window.OAAgent = window.OAAgent || {};
  window.OAAgent.open = function () {
    setOpen(true);
  };
  window.OAAgent.close = function () {
    setOpen(false);
  };
  window.OAAgent.toggle = function () {
    setOpen(!open);
  };

  // 宿主頁可能把 script 放在 <head>，此時 body 尚未存在 → 等 DOM ready 再掛載
  function mount() {
    document.body.appendChild(panel);
    // 預設掛上浮動按鈕；data-launcher="none" 時略過（由宿主自己的按鈕觸發）
    if (showLauncher) document.body.appendChild(btn);
  }
  if (document.body) {
    mount();
  } else {
    document.addEventListener("DOMContentLoaded", mount);
  }
})();
