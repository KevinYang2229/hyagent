/**
 * HyAgent 嵌入式聊天 widget（POC）。
 *
 * 第三方網站只要加一行即可接入（src 為 HyAgent 自己的對外網域——
 * 面板 iframe 的來源就是從這個 script 的 src 推得，見下方 `origin`，
 * 因此本檔**必須**由 HyAgent 託管，不可讓整合方複製到自己的網域）：
 *   <script src="https://<hyagent 網域>/sdk/widget.js"></script>
 *
 * 對外路徑固定為 `/sdk/widget.js`（規格 §7.2 定稿）：不含版本號的單一**可變**路徑，
 * HyAgent 得就地更新以推送修補，因此它的 Cache-Control `max-age` 不得超過 5 分鐘
 * （見 client/nginx.conf.template）。不強制 SRI——託管被攻破時後端回應同樣可竄改，
 * SRI 只保護單一檔案，卻換掉緊急修補的能力。
 *
 * 載入後在右下角注入一顆浮動按鈕，點擊彈出聊天視窗（iframe 載入 OA panel 的 ?embed=1 模式）。
 * 面板標題列另有放大鈕：放大後面板水平、垂直置中並蓋上背景遮罩，點遮罩或 Esc 還原。
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
      // 先認定稿路徑 /sdk/widget.js：宿主頁上另有同名的第三方 widget.js 時，寬鬆比對會挑錯人，
      // 而挑錯的後果是 origin 算成別人的網域、面板永遠載不起來。找不到才退回寬鬆比對，
      // 讓自行託管到其他路徑的情況仍能自救。
      for (var i = all.length - 1; i >= 0; i--) {
        if (all[i].src && all[i].src.indexOf("/sdk/widget.js") !== -1) return all[i];
      }
      for (var j = all.length - 1; j >= 0; j--) {
        if (all[j].src && all[j].src.indexOf("widget.js") !== -1) return all[j];
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
  //   data-position    浮動按鈕位置 br 右下（預設）/ bl 左下 / tr 右上 / tl 左上
  //                    （相容舊值：right→br、left→bl）
  //   data-size        啟動按鈕尺寸（px）48 / 52 / 56（預設）；其他值視為未設
  //   data-offset-x    距側邊（左或右，依 position）距離（px，預設 20）
  //   data-offset-y    距上／下緣（依 position）距離（px，預設 20；調高可避開頁面既有的 go-to-top 按鈕）
  //   data-token-url   SSO handoff：宿主自家的 Identity Endpoint（Token Provider，規格 §6.5）。
  //                    面板需要身分時才由這裡同源帶 cookie 取回，經 postMessage 交給面板。
  //   data-debug       "1" 時把 SSO 握手與登入者印到 console（整合期除錯用，正式站請拿掉）
  function attr(name) {
    var v = script.getAttribute(name);
    return v && v.trim() ? v.trim() : null;
  }
  // 啟動按鈕文字優先序：data-title（宿主明確覆寫）> 租戶後台 AI 名稱（稍後 async 補上）> 預設
  var explicitTitle = attr("data-title");
  var title = explicitTitle || "OA 小幫手";
  // 宿主明確指定的主題／位置（data-*）；有指定就優先，後端外觀不再覆寫。
  var explicitTheme = attr("data-theme");
  // 四角位置；舊版只有 right/left（＝右下/左下），保留相容。無法辨識的值一律當沒設。
  var VALID_POSITIONS = { br: 1, bl: 1, tr: 1, tl: 1 };
  function normalizePosition(v) {
    if (typeof v !== "string") return null;
    var p = v.trim().toLowerCase();
    if (p === "right") return "br";
    if (p === "left") return "bl";
    return VALID_POSITIONS[p] ? p : null;
  }
  // 有帶 data-position（即使值不合法）就視為宿主已明確指定，後端 appearance 不再覆寫
  var explicitPosition = attr("data-position");
  var position = normalizePosition(explicitPosition) || "br";
  // 啟動按鈕尺寸（px）：只收 40 / 44 / 48 / 52 / 56 五段；宿主 data-size 優先，否則稍後採後端 appearance。
  // 固定五段而非任意數值，是為了讓 icon／標籤等比例維持設計比例，宿主頁不會出現破版大小。
  var VALID_SIZES = { 40: 1, 44: 1, 48: 1, 52: 1, 56: 1 };
  function normalizeSize(v) {
    var n = parseInt(v, 10);
    return VALID_SIZES[n] ? n : null;
  }
  var explicitSize = attr("data-size");
  var size = normalizeSize(explicitSize) || 56;

  // 啟動按鈕距邊距（px）：宿主 data-offset-x/y 優先，否則稍後採後端 appearance；預設 20。
  // offsetY 是距「下緣」（br/bl）或「上緣」（tr/tl）的距離；調高可避開宿主頁既有的 go-to-top 等按鈕。
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
  // data-token-url：宿主自家的 Identity Endpoint（同源路徑或絕對網址）。
  // 宿主端點用自己的登入 cookie 決定發給誰，簽章金鑰留在宿主後端，永不下放到瀏覽器。
  var tokenUrl = attr("data-token-url");

  // data-user-token（已移除）：靜態字串滿足不了規格 §6.5 —— Assertion 只有 60 秒有效且是
  // 一次性的兌換券。頁面停久一點、使用者按上一頁、或頁面被 bfcache 還原，拿到的都是同一張
  // 早已過期或已用過的票；頁面若被 CDN 快取，那張票還會一併外流（§10.1）。改用 data-token-url。
  if (attr("data-user-token")) {
    console.warn(
      "[oa-agent] data-user-token 已移除（Assertion 為一次性且僅 60 秒有效），請改用 data-token-url",
    );
  }

  // data-debug="1"：把整段 SSO 握手印到 console（宿主頁這一側標 [hyagent:host]，
  // 面板那一側由 ?debug=1 帶進去標 [hyagent:panel]）。整合期用來回答兩個問題：
  // 「面板到底登入了誰」與「從 Identity Endpoint／HyAgent 取回了什麼」。
  //
  // 預設關閉，正式站不要開：console 的內容會被截圖、被貼進 issue。開啟時也只印遮罩過的
  // 憑證片段與 claims 摘要，Assertion 原文不進 console。
  var debug = /^(1|true|on)$/i.test(attr("data-debug") || "");
  var DEBUG_STYLE = "color:#fff;background:#2563eb;padding:1px 5px;border-radius:3px";
  function dlog() {
    if (!debug) return;
    var args = ["%c[hyagent:host]", DEBUG_STYLE];
    for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
    try {
      console.log.apply(console, args);
    } catch (_e) {}
  }
  /** 憑證只印前 8 碼與長度——足以比對「是不是同一張」，又不足以拿去用。 */
  function maskToken(t) {
    return t ? t.slice(0, 8) + "…（共 " + t.length + " 字元）" : "(無)";
  }
  /**
   * 解出 JWS 的 header／payload 供除錯檢視。
   * 純顯示用：這裡**不驗章**，真正的驗證在 HyAgent 後端（規格 §8）。
   */
  function decodeJws(t) {
    function seg(part) {
      var b64 = part.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      var bin = atob(b64);
      var text;
      if (typeof TextDecoder === "function") {
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = new TextDecoder("utf-8").decode(bytes);
      } else {
        text = decodeURIComponent(escape(bin)); // 舊瀏覽器退路：claims 含中文姓名，不能直接用 atob 的結果
      }
      return JSON.parse(text);
    }
    try {
      var parts = String(t).split(".");
      if (parts.length < 2) return null;
      return { header: seg(parts[0]), payload: seg(parts[1]) };
    } catch (_e) {
      return null;
    }
  }

  // 把設定組成 panel iframe 的 query；只附帶有值的參數。
  // 身分憑證**不在這裡**：Assertion 一律走 postMessage（規格 §10.1 明文禁止放進 URL，
  // 否則會留在瀏覽器歷史、Referer header 與伺服器存取日誌這三個不受控的地方）。
  var panelParams = ["embed=1"];
  var cfg = {
    key: attr("data-key"),
    form: attr("data-form"),
    locale: attr("data-locale"),
    theme: explicitTheme,
  };
  for (var ck in cfg) {
    if (cfg[ck]) panelParams.push(ck + "=" + encodeURIComponent(cfg[ck]));
  }
  // URL 上只留兩件非機敏的事實：
  //   host=      面板要指定 postMessage 的 targetOrigin 就得先知道宿主是誰（§6.6 禁用 "*"），
  //              而 document.referrer 會被宿主頁的 Referrer-Policy 清掉，不能當唯一來源。
  //   identity=1 宿主頁備有 Token Provider。沒有就讓面板直接走自行登入，不必空等一次握手。
  function buildPanelUrl() {
    var params = panelParams.slice();
    params.push("host=" + encodeURIComponent(window.location.origin));
    if (tokenUrl) params.push("identity=1");
    // 面板跑在 iframe 裡，宿主頁的 data-debug 傳不進去 → 用同一個 query 把開關帶過去
    if (debug) params.push("debug=1");
    return origin + "/?" + params.join("&");
  }

  dlog("widget 初始化", {
    宿主頁: window.location.origin,
    面板來源: origin,
    API: apiBase,
    租戶金鑰: cfg.key || "(未設，後端會落到預設租戶)",
    IdentityEndpoint: tokenUrl || "(未設，面板將走自行登入)",
  });

  var Z = 2147483000; // 盡量蓋在宿主頁面之上
  var open = false;
  var expanded = false; // 放大模式：面板置中撐大並蓋上背景遮罩
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
      "width:var(--oa-launcher-size,56px);height:var(--oa-launcher-size,56px);",
      "border-radius:50%;border:none;outline:none;padding:0;margin:0;",
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
      // icon 隨按鈕尺寸等比例縮放（34/56≈.61），三段尺寸下留白比例一致
      "width:calc(var(--oa-launcher-size,56px) * .61);",
      "height:calc(var(--oa-launcher-size,56px) * .61);",
      "display:block;will-change:transform;",
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
      // 標籤掛點依位置調整（data-oa-pos 由 applyPosition 寫入）：四角一律水平掛在按鈕
      // 「靠畫面中央」的那一側，標籤往中央延伸，名稱再長都不會撞到視窗邊緣。
      // 右側兩角（br/tr）用上面的基礎規則掛左邊；左側兩角（bl/tl）貼著左邊緣，改掛右邊才有空間。
      '#oa-agent-launcher[data-oa-pos="bl"] .oa-agent-label,',
      '#oa-agent-launcher[data-oa-pos="tl"] .oa-agent-label{',
      "right:auto;left:calc(100% + 12px);",
      "transform:translateY(-50%) translateX(-10px);",
      "}",
      '#oa-agent-launcher[data-oa-pos="bl"]:hover .oa-agent-label,',
      '#oa-agent-launcher[data-oa-pos="bl"]:focus-visible .oa-agent-label,',
      '#oa-agent-launcher[data-oa-pos="tl"]:hover .oa-agent-label,',
      '#oa-agent-launcher[data-oa-pos="tl"]:focus-visible .oa-agent-label{',
      "transform:translateY(-50%) translateX(0);",
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
        dlog("租戶設定（GET /api/widget/config）", (j && j.data) || j);
        var ap = j && j.data && j.data.appearance;
        if (!ap) return;
        if (!explicitTitle && ap.assistantName && ap.assistantName.trim()) {
          title = ap.assistantName.trim();
          label.textContent = title;
          btn.setAttribute("aria-label", title);
        }
        if (ap.primaryColor) applyPrimary(ap.primaryColor);
        // 位置與邊距：宿主未用 data-* 覆寫時，採用後端 appearance（br/bl/tr/tl；offset px）
        // theme 不在此處理：面板內 SPA 會自行套用租戶 theme，且尊重使用者在 widget 內的手動切換偏好。
        if (!explicitPosition && ap.position) {
          position = normalizePosition(ap.position) || position;
        }
        if (explicitSize === null && ap.launcherSize != null) {
          size = normalizeSize(ap.launcherSize) || size;
        }
        if (explicitOffsetX === null && ap.offsetX != null)
          offsetX = clampOffset(ap.offsetX);
        if (explicitOffsetY === null && ap.offsetY != null)
          offsetY = clampOffset(ap.offsetY);
        // applySize 會連帶重跑 applyPosition（面板讓位距離依按鈕尺寸計算）
        applySize();
      })
      .catch(function () {});
  }

  // ---- 放大模式的背景遮罩 ----
  // 蓋在宿主頁之上、面板之下；點一下即還原成小視窗（與 Esc 同效）。
  var backdrop = document.createElement("div");
  backdrop.id = "oa-agent-backdrop";
  backdrop.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    "bottom:0",
    "background:rgba(15,23,42,.45)",
    "backdrop-filter:blur(2px)",
    "-webkit-backdrop-filter:blur(2px)",
    "z-index:" + (Z - 1),
    "display:none",
    "opacity:0",
    "transition:opacity .2s ease",
  ].join(";");

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

  // 面板幾何：放大模式 > 手機（窄螢幕）近全螢幕 > 桌機四角小視窗。
  // 每個分支都要把另一組定位屬性歸零（left/top ↔ right/bottom、margin），否則切換後殘值會把面板推出畫面。
  function applyPanelGeometry() {
    if (expanded && window.innerWidth > 480) {
      // 四邊定位搭配 auto margin 置中，保留 transform 給開關動畫使用。
      panel.style.margin = "auto";
      panel.style.top = "0";
      panel.style.bottom = "0";
      panel.style.left = "0";
      panel.style.right = "0";
      panel.style.width = "min(1180px, calc(100vw - 48px))";
      panel.style.height = "calc(100vh - 48px)";
      panel.style.maxWidth = "calc(100vw - 48px)";
      panel.style.maxHeight = "900px";
      panel.style.borderRadius = "16px";
      return;
    }
    panel.style.margin = "";
    if (window.innerWidth <= 480) {
      panel.style.top = "auto";
      panel.style.left = "0";
      panel.style.right = "0";
      panel.style.bottom = "0";
      panel.style.width = "100vw";
      panel.style.height = "100vh";
      // 手機全螢幕要一併放寬 max-width，否則被預設的 calc(100vw - 40px) 夾住而右側留白
      panel.style.maxWidth = "100vw";
      panel.style.maxHeight = "100vh";
      panel.style.borderRadius = "0";
    } else {
      panel.style.width = "400px";
      panel.style.height = "640px";
      panel.style.maxWidth = "calc(100vw - 40px)";
      panel.style.maxHeight = "calc(100vh - 120px)";
      panel.style.borderRadius = "16px";
      applyPosition();
    }
  }
  applyPanelGeometry();
  window.addEventListener("resize", function () {
    // 縮到手機寬度時本來就已是全螢幕，放大模式沒有意義 → 自動還原（順便收掉遮罩）
    if (expanded && window.innerWidth <= 480) setExpanded(false);
    else {
      applyPanelGeometry();
      notifyExpanded();
    }
  });

  // ---- Token Provider（規格 §5.2、§6.5）----
  // 向宿主自家 Identity Endpoint 取一張**當下新簽發**的 Assertion（帶 cookie，
  // 宿主用自己的登入狀態決定發給誰）。契約重點：單次等待上限 10 秒、失敗以指數退避重試最多
  // 3 次、絕不快取結果。任何失敗都回 null 而不是讓面板開不起來：面板照常開，使用者自行登入。
  //
  // 方法是 GET：規格 §5.2 的端點定義（GET /api/mybot/identity）與 CSRF 那列「為 GET 且不改變
  // 狀態」都以 GET 為準。同源請求瀏覽器會自動帶 Sec-Fetch-Site: same-origin，客戶端點得據此
  // 擋掉他站的簡單請求。credentials 用 include 而非規格範例的 same-origin，是為了讓端點也能
  // 架在別的網域（同源時兩者行為相同，跨源則需端點自行設好 CORS）。
  var PROVIDER_TIMEOUT_MS = 10000;
  var PROVIDER_BACKOFF_MS = [1000, 2000, 4000];

  // 單次呼叫。回 { assertion } 成功，或 { retryable } 失敗。
  function callTokenProviderOnce() {
    if (typeof fetch !== "function") return Promise.resolve({ retryable: false });
    // 沒有 AbortController 的環境退回「無逾時的請求」：拿不到票也好過整段流程當掉
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, PROVIDER_TIMEOUT_MS);
    var init = {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
      // 端點若被瀏覽器或 CDN 快取，拿回來的會是同一張已用過的票 → 後端 TOKEN_REPLAYED。
      // 規格 §5.2 另要求端點自己回 Cache-Control: no-store，這裡是請求端的同一道防線。
      cache: "no-store",
    };
    if (ctrl) init.signal = ctrl.signal;
    return fetch(tokenUrl, init)
      .then(
        function (res) {
          dlog("Identity Endpoint 回應 HTTP " + res.status + "：" + tokenUrl);
          // 401 / 403＝使用者根本沒登入宿主網站，重試幾次仍舊沒登入 → 直接走匿名模式（§6.5）。
          // 只有 5xx 這種暫時性失敗才值得退避重試。
          if (!res.ok) return { retryable: res.status >= 500 };
          return res.json().then(
            function (json) {
              // 相容四種回應形狀：{assertion} / {token} / {userToken} / {data:{…}}
              var body = (json && json.data) || json || {};
              var t = body.assertion || body.token || body.userToken;
              return typeof t === "string" && t ? { assertion: t } : { retryable: false };
            },
            function () {
              return { retryable: false }; // 回應不是 JSON：端點設定有誤，重試無益
            },
          );
        },
        function () {
          return { retryable: true }; // 網路錯誤或逾時 abort
        },
      )
      .then(function (r) {
        clearTimeout(timer);
        return r;
      });
  }

  // 初次 + 最多 3 次退避重試（1s / 2s / 4s）。全數失敗回 null。
  function callTokenProvider(attempt) {
    attempt = attempt || 0;
    return callTokenProviderOnce().then(function (r) {
      if (r.assertion) return r.assertion;
      if (!r.retryable || attempt >= PROVIDER_BACKOFF_MS.length) return null;
      return new Promise(function (resolve) {
        setTimeout(resolve, PROVIDER_BACKOFF_MS[attempt]);
      }).then(function () {
        return callTokenProvider(attempt + 1);
      });
    });
  }

  // ---- postMessage 協定（規格 §6.6）----
  //   host → panel   identity:response / ui:state / session:logout / identity:refresh
  //   panel → host   handshake / identity:request / ui:close / ui:expand / event / session:ack
  var MSG_SOURCE = "hyagent";
  var MSG_VERSION = 1;

  // 送訊息給面板。targetOrigin 恆為面板來源，絕不使用 "*"（§6.6）。
  function sendToPanel(type, payload, requestId) {
    if (!iframe || !iframe.contentWindow) return;
    var message = { source: MSG_SOURCE, version: MSG_VERSION, type: type };
    if (requestId !== undefined) message.requestId = requestId;
    if (payload !== undefined) message.payload = payload;
    try {
      iframe.contentWindow.postMessage(message, origin);
    } catch (_e) {}
  }

  // 面板要先 handshake 才收得到訊息——iframe 還在載入時 postMessage 會直接掉在地上。
  // 宿主頁主動發起的訊息（登出／換身分）因此先排隊，等面板回報就緒再一次送出。
  var panelReady = false;
  var queuedToPanel = [];

  function sendWhenReady(type, payload, requestId) {
    if (panelReady) {
      sendToPanel(type, payload, requestId);
      return;
    }
    queuedToPanel.push([type, payload, requestId]);
  }

  function flushQueuedToPanel() {
    panelReady = true;
    var queued = queuedToPanel;
    queuedToPanel = [];
    for (var i = 0; i < queued.length; i++) sendToPanel(queued[i][0], queued[i][1], queued[i][2]);
  }

  function newRequestId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    } catch (_e) {}
    return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // 宿主頁 → 面板的請求（session:logout / identity:refresh），面板處理完回一則 session:ack。
  //
  // 逾時就放行：這兩支多半接在「按下登出，馬上要導頁」後面，卡住宿主頁比漏掉一則 ack 更糟。
  // 面板那側清本地憑證與通知後端作廢都是同步發動的（fetch 帶 keepalive），導頁不會取消它。
  var ACK_TIMEOUT_MS = 5000;
  var pendingAcks = {};

  function askPanel(type) {
    // 面板可能從頭到尾沒被點開過，但 Session 仍躺在**面板網域**的 sessionStorage 裡
    // （同一個分頁重整不會清掉它）。那份只有面板自己碰得到，所以這裡先把 iframe 建起來
    // （面板收起時它本來就不可見）再問，否則登出會只清掉宿主這側什麼都沒有的狀態。
    ensureIframe();
    var requestId = newRequestId();
    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        delete pendingAcks[requestId];
        dlog("面板沒有回應 " + type + "（逾時 " + ACK_TIMEOUT_MS + "ms），不再等待");
        resolve(false);
      }, ACK_TIMEOUT_MS);
      pendingAcks[requestId] = function (ack) {
        clearTimeout(timer);
        delete pendingAcks[requestId];
        dlog("面板已處理 " + type, ack || {});
        resolve(!ack || ack.ok !== false);
      };
      sendWhenReady(type, null, requestId);
    });
  }

  // 面板送來 identity:request → 取一張票回去。
  // 不快取、不共用結果：Assertion 是一次性兌換券，同一張送兩次第二次會被 TOKEN_REPLAYED 拒絕。
  function provideIdentity(requestId) {
    if (!tokenUrl) {
      dlog("面板要求身分，但未設 data-token-url → 回 NO_TOKEN_PROVIDER");
      sendToPanel("identity:response", { assertion: null, error: { code: "NO_TOKEN_PROVIDER" } }, requestId);
      return;
    }
    dlog("面板要求身分 → 向 Identity Endpoint 取票：" + tokenUrl);
    callTokenProvider().then(function (assertion) {
      if (assertion) {
        if (debug) {
          var jws = decodeJws(assertion);
          dlog("取得 Identity Assertion（交給面板）", {
            assertion: maskToken(assertion),
            kid: (jws && jws.header && jws.header.kid) || "(解不出)",
            // iss＝租戶、sub＝貴站的使用者代號、name＝顯示名、exp＝到期時間
            claims: (jws && jws.payload) || "(解不出)",
          });
        }
        sendToPanel("identity:response", { assertion: assertion }, requestId);
        return;
      }
      console.warn("[oa-agent] 無法從 data-token-url 取得使用者憑證，面板改為自行登入：", tokenUrl);
      sendToPanel(
        "identity:response",
        { assertion: null, error: { code: "TOKEN_PROVIDER_FAILED" } },
        requestId,
      );
    });
  }

  // 身分改走 postMessage 之後，iframe 不必再等換票才能建立——點開面板即刻載入，
  // 取票與面板渲染並行。改造前那段「先 fetch 再 createIframe」的延遲一併消失。
  function ensureIframe() {
    if (iframe) return;
    iframe = document.createElement("iframe");
    iframe.src = buildPanelUrl();
    iframe.title = title;
    // 面板要能讀到 document.referrer 才有辦法告訴後端「是誰把它嵌起來」（規格 §8.6）。
    // 元素層級的 referrerpolicy 優先於宿主頁的全域 Referrer-Policy，因此就算宿主頁設了
    // no-referrer，這個 iframe 仍讀得到來源。用 "origin" 而非 "no-referrer-when-downgrade"：
    // 後端只需要 origin，送出完整路徑等於把宿主頁的網址洩漏給我們，沒有必要。
    iframe.referrerPolicy = "origin";
    iframe.style.cssText = "width:100%;height:100%;border:none;display:block;";
    // 面板載好才收得到 message：載入完成回報一次，SPA 才知道要不要顯示放大鈕
    iframe.addEventListener("load", notifyExpanded);
    panel.appendChild(iframe);
  }

  function setOpen(next) {
    open = next;
    if (open) {
      ensureIframe();
      panel.style.display = "block";
      // 下一幀再做過場動畫
      requestAnimationFrame(function () {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0)";
      });
    } else {
      // 收起時一併還原放大狀態，下次點開回到小視窗（與宿主頁的預期一致）
      if (expanded) setExpanded(false);
      panel.style.opacity = "0";
      panel.style.transform = "translateY(8px)";
      setTimeout(function () {
        if (!open) panel.style.display = "none";
      }, 150);
    }
  }

  // 放大／還原：面板置中撐大 + 背景遮罩；手機（≤480）本來就全螢幕，一律當作未放大。
  // 面板內的 SPA 會依自身寬度自動切成雙欄（聊天 + 表單明細側欄），這裡只負責容器尺寸。
  function setExpanded(next) {
    expanded = !!next && window.innerWidth > 480;
    applyPanelGeometry();
    if (expanded) {
      backdrop.style.display = "block";
      requestAnimationFrame(function () {
        backdrop.style.opacity = "1";
      });
    } else {
      backdrop.style.opacity = "0";
      setTimeout(function () {
        if (!expanded) backdrop.style.display = "none";
      }, 200);
    }
    // 放大時藏起浮動按鈕：它 z-index 在遮罩之上，留著會浮在暗幕上很突兀（收起仍可用標題列的 ✕）
    if (showLauncher) btn.style.display = expanded ? "none" : "";
    notifyExpanded();
  }

  // 回報面板內的 SPA：目前是否放大（讓按鈕圖示與實際狀態一致），以及這個視窗寬度能不能放大。
  // available 必須由這裡告知——面板內的 CSS media query 量到的是 iframe 自己的寬（永遠是小視窗的
  // 400px），無從分辨「桌機小視窗」與「手機全螢幕」，只有宿主頁這一層知道真正的視窗寬度。
  function notifyExpanded() {
    sendToPanel("ui:state", { expanded: expanded, available: window.innerWidth > 480 });
  }

  // 遮罩點擊 / Esc：還原成小視窗（不直接關閉，避免誤觸就中斷對話）
  backdrop.addEventListener("click", function () {
    setExpanded(false);
  });
  document.addEventListener("keydown", function (e) {
    if (expanded && (e.key === "Escape" || e.key === "Esc")) setExpanded(false);
  });

  btn.addEventListener("click", function () {
    setOpen(!open);
  });

  // 啟動按鈕／面板定位：br 右下（預設）/ bl 左下 / tr 右上 / tl 左上，依 offsetX/offsetY 邊距擺放。
  // 抽成函式以便後端 appearance（position/offset）非同步回來時動態重套；pos 省略時沿用目前 position。
  // data-oa-pos 同步寫到按鈕上，供 CSS 決定 .oa-agent-label 掛在哪一側。
  function applyPosition(pos) {
    if (pos) position = normalizePosition(pos) || position;
    var left = position === "bl" || position === "tl";
    var top = position === "tl" || position === "tr";
    btn.setAttribute("data-oa-pos", position);
    btn.style.left = left ? offsetX + "px" : "auto";
    btn.style.right = left ? "auto" : offsetX + "px";
    btn.style.top = top ? offsetY + "px" : "auto";
    btn.style.bottom = top ? "auto" : offsetY + "px";
    // 放大中維持置中，不套用四角小視窗的邊距。
    if (expanded && window.innerWidth > 480) {
      applyPanelGeometry();
      return;
    }
    // 面板：桌機依邊距定位（縱向再讓開按鈕本身高度＋12px 間距）；手機為全螢幕，由 applyMobile 處理、不套邊距
    if (window.innerWidth > 480) {
      var gap = offsetY + size + 12;
      panel.style.left = left ? offsetX + "px" : "auto";
      panel.style.right = left ? "auto" : offsetX + "px";
      panel.style.top = top ? gap + "px" : "auto";
      panel.style.bottom = top ? "auto" : gap + "px";
    }
  }
  // 啟動按鈕尺寸：寫進 CSS 變數（按鈕與 icon 都吃它），面板讓位距離也跟著重算。
  // 同樣抽成函式，供後端 appearance（launcherSize）非同步回來時動態重套。
  function applySize() {
    btn.style.setProperty("--oa-launcher-size", size + "px");
    applyPosition();
  }
  applySize();

  // 面板送來的訊息（規格 §6.6 信封）。三重檢查缺一不可：
  //   e.origin  必須是面板來源       —— 擋掉宿主頁上其他來源的 frame
  //   e.source  必須是我們建的 iframe —— 只驗 origin 擋不住同源的其他 frame 冒充面板
  //   信封      必須是 hyagent v1     —— 擋掉宿主頁自己或第三方腳本的無關訊息
  window.addEventListener("message", function (e) {
    if (e.origin !== origin) return;
    if (!iframe || e.source !== iframe.contentWindow) return;
    var msg = e.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.source !== MSG_SOURCE || msg.version !== MSG_VERSION) return;
    if (typeof msg.type !== "string") return;
    var payload = msg.payload || {};

    if (msg.type === "handshake") {
      // 面板就緒：回報一次目前放大狀態（面板靠這個決定要不要顯示放大鈕），
      // 並把面板就緒前排隊的訊息（OAAgent.logout() / refreshIdentity()）送出去。
      notifyExpanded();
      flushQueuedToPanel();
    } else if (msg.type === "session:ack") {
      // 面板回報「登出／換身分已處理完」
      var ack = pendingAcks[msg.requestId];
      if (ack) ack(payload);
    } else if (msg.type === "identity:request") {
      provideIdentity(msg.requestId);
    } else if (msg.type === "ui:close") {
      setOpen(false);
      dispatchToHost("oa-agent:close", payload);
    } else if (msg.type === "ui:expand") {
      // 面板內標題列的放大／還原鈕
      setExpanded(payload.expanded !== false);
      dispatchToHost("oa-agent:expand", payload);
    } else if (msg.type === "event") {
      // 面板轉發的事件（如表單已送出）
      if (typeof payload.name === "string") dispatchToHost(payload.name, payload.detail);
    }
  });

  // 轉發給宿主頁：DOM CustomEvent（window.addEventListener('oa-agent:submitted', …)）＋可選全域 callback。
  // 事件名與 detail 形狀沿用改造前的 oa-agent:*，宿主頁既有的接線不受本次協定改版影響。
  function dispatchToHost(name, detail) {
    var legacy = { type: name };
    if (detail && typeof detail === "object") {
      for (var k in detail) legacy[k] = detail[k];
    }
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: legacy }));
    } catch (_e) {}
    if (window.OAAgent && typeof window.OAAgent.onEvent === "function") {
      try {
        window.OAAgent.onEvent(legacy);
      } catch (_e2) {}
    }
  }

  // 宿主頁可程式化控制：OAAgent.open() / close() / toggle() / expand() / collapse()；
  // onEvent 可在載入前先指定（保留之）
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
  window.OAAgent.expand = function () {
    if (!open) setOpen(true);
    setExpanded(true);
  };
  window.OAAgent.collapse = function () {
    setExpanded(false);
  };

  /**
   * 使用者登出貴站時呼叫（規格 §6.3，整合手冊 §5.3「這段一定要做」）。
   *
   * HyAgent Session 存在**伺服器端**，只清瀏覽器那一份等於留一張還能用的票在後端直到
   * 自然過期；共用電腦上那正是登出要防的情境。這支請面板作廢它（POST /api/auth/logout）
   * 並清掉面板網域的 sessionStorage——那份宿主頁碰不到，只有面板自己清得掉。
   *
   * 回傳 Promise<boolean>：導頁前 `await` 它最穩妥（面板可能還在載入）；不 await 也行，
   * 面板那側是同步發動、帶 keepalive 的請求，導頁不會取消它。
   */
  window.OAAgent.logout = function () {
    dlog("宿主頁要求登出 → 通知面板作廢 Session");
    return askPanel("session:logout").then(function (ok) {
      setOpen(false);
      return ok;
    });
  };

  /**
   * 貴站的登入者換人時呼叫（規格 §6.3，手冊 §5.3 第二列）。
   *
   * 面板會**先作廢舊 Session 再**向 data-token-url 取一張新的 Assertion 換發：只換新的
   * 不作廢舊的，等於同一個瀏覽器上同時有兩個人的票還活著。不呼叫的話，面板會維持前一位
   * 使用者的身分直到 Session 自然過期——SDK 看不到貴站的登入狀態，這件事只有你們知道。
   */
  window.OAAgent.refreshIdentity = function () {
    dlog("宿主頁要求重取身分 → 通知面板換發");
    return askPanel("identity:refresh");
  };

  // 宿主頁可能把 script 放在 <head>，此時 body 尚未存在 → 等 DOM ready 再掛載
  function mount() {
    document.body.appendChild(backdrop);
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
