/**
 * HyAgent 嵌入式聊天 widget（POC）。
 *
 * 第三方網站只要加一行即可接入：
 *   <script src="https://<你的網域>/widget.js"></script>
 *
 * 載入後在右下角注入一顆浮動按鈕，點擊彈出聊天視窗（iframe 載入 OA panel 的 ?embed=1 模式）。
 * 面板標題列另有放大鈕：放大後面板置中撐大並蓋上背景遮罩，點遮罩或 Esc 還原。
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
  //   data-position    浮動按鈕位置 br 右下（預設）/ bl 左下 / tr 右上 / tl 左上
  //                    （相容舊值：right→br、left→bl）
  //   data-size        啟動按鈕尺寸（px）48 / 52 / 56（預設）；其他值視為未設
  //   data-offset-x    距側邊（左或右，依 position）距離（px，預設 20）
  //   data-offset-y    距上／下緣（依 position）距離（px，預設 20；調高可避開頁面既有的 go-to-top 按鈕）
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
  // 啟動按鈕尺寸（px）：只收 48 / 52 / 56 三段；宿主 data-size 優先，否則稍後採後端 appearance。
  // 固定三段而非任意數值，是為了讓 icon／標籤等比例維持設計比例，宿主頁不會出現破版大小。
  var VALID_SIZES = { 48: 1, 52: 1, 56: 1 };
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
      // 置中：四邊 inset 歸零 + margin:auto，寬高取「設計上限」與「視窗扣掉留白」的較小者
      panel.style.margin = "auto";
      panel.style.top = "0";
      panel.style.left = "0";
      panel.style.right = "0";
      panel.style.bottom = "0";
      panel.style.width = "min(1180px, calc(100vw - 48px))";
      panel.style.height = "min(820px, calc(100vh - 48px))";
      panel.style.maxWidth = "calc(100vw - 48px)";
      panel.style.maxHeight = "calc(100vh - 48px)";
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

  function setOpen(next) {
    open = next;
    if (open) {
      if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.src = panelUrl;
        iframe.title = title;
        iframe.style.cssText =
          "width:100%;height:100%;border:none;display:block;";
        // 面板載好才收得到 message：載入完成回報一次，SPA 才知道要不要顯示放大鈕
        iframe.addEventListener("load", notifyExpanded);
        panel.appendChild(iframe);
      }
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
    if (!iframe || !iframe.contentWindow) return;
    try {
      iframe.contentWindow.postMessage(
        {
          type: "oa-agent:expanded",
          expanded: expanded,
          available: window.innerWidth > 480,
        },
        origin,
      );
    } catch (_e) {}
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

  // panel 內聊天頁透過 postMessage 與宿主溝通：oa-agent:close 收起、oa-agent:submitted 已送出…
  window.addEventListener("message", function (e) {
    if (e.origin !== origin || !e.data || typeof e.data.type !== "string")
      return;
    var type = e.data.type;
    if (type === "oa-agent:close") setOpen(false);
    // 面板內標題列的放大／還原鈕
    if (type === "oa-agent:expand") setExpanded(e.data.expanded !== false);
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
