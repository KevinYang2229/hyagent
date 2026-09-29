@echo off
rem =====================================================================
rem  HyAgent presale demo：SDK 自訂 UI（headless SDK，不用 widget / iframe）
rem  位置：presale\sdk-custom-ui\run_sdk_ui.bat
rem  用法：直接雙擊，或從任何目錄執行本檔
rem  設定：一律來自同目錄 .env（本檔不帶任何預設值）
rem  相依：先跑 run_server.bat（API）。這版不載 widget.js，不需要 run_client.bat
rem
rem  下面五行是 UTF-8 外殼：cmd.exe 若在批次檔「中途」才 chcp，之後的 goto
rem  會因為位元組位移而執行到半行。所以先切好字碼頁，再用新的 cmd 重跑本檔。
rem =====================================================================
if "%~1"=="--utf8" goto :main
for /f "tokens=2 delims=:" %%c in ('chcp') do set "_OLDCP=%%c"
chcp 65001 >nul
cmd /d /c ""%~f0" --utf8 %*"
set "_RC=%ERRORLEVEL%"
if defined _OLDCP chcp %_OLDCP% >nul
exit /b %_RC%

:main
setlocal

set "SDKUI_DIR=%~dp0"
pushd "%~dp0..\.." || goto :fail
set "ROOT=%CD%"

echo.
echo =====================================================
echo   HyAgent SDK 自訂 UI 網站  presale/sdk-custom-ui
echo   repo 根目錄：%ROOT%
echo =====================================================
echo.

rem --- 1. Node 版本檢查 -----------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [錯誤] 找不到 node，請先安裝 Node.js 22.6 以上版本。
    goto :fail
)

set "NODE_MAJOR=0"
set "NODE_MINOR=0"
for /f "tokens=1,2 delims=v." %%a in ('node -v') do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)
if "%NODE_MINOR%"=="" set "NODE_MINOR=0"

rem  @hyagent/sdk/server 的進入點是 .ts，要靠 Node 的 TypeScript 型別剝離才跑得動：
rem    22.6 ～ 22.17 → 得補 --experimental-strip-types
rem    22.18 以上    → 預設就開，不用補
rem  （瀏覽器端的 app.ts 另由 esbuild 打包，跟這個旗標無關）
set "STRIP="
if %NODE_MAJOR% LSS 22 goto :oldnode
if %NODE_MAJOR% EQU 22 (
    if %NODE_MINOR% LSS 6 goto :oldnode
    if %NODE_MINOR% LSS 18 set "STRIP=--experimental-strip-types"
)
echo [1/5] Node v%NODE_MAJOR%.%NODE_MINOR% OK
goto :deps

:oldnode
echo [錯誤] Node 版本過舊：v%NODE_MAJOR%.%NODE_MINOR%，本 demo 需要 22.6 以上。
goto :fail

rem --- 2. workspace 相依 ----------------------------------------------
rem  比 widge-tenant 多一個 esbuild：server.mjs 啟動時用它把 app.ts + SDK 打包成 /app.js。
:deps
set "DEPS_OK=1"
if not exist "%ROOT%\node_modules\@hyagent\sdk\package.json" set "DEPS_OK="
if not exist "%ROOT%\node_modules\esbuild\package.json" set "DEPS_OK="
if defined DEPS_OK (
    echo [2/5] 相依套件已就緒（@hyagent/sdk、esbuild）
) else (
    echo [2/5] 缺少 @hyagent/sdk 或 esbuild，執行 npm install ...
    call npm install
    if errorlevel 1 (
        echo [錯誤] npm install 失敗，請手動到 repo 根目錄執行 npm install。
        goto :fail
    )
    if not exist "%ROOT%\node_modules\@hyagent\sdk\package.json" (
        echo [錯誤] npm install 跑完，但仍找不到 node_modules\@hyagent\sdk
        goto :fail
    )
    if not exist "%ROOT%\node_modules\esbuild\package.json" (
        echo [錯誤] npm install 跑完，但仍找不到 node_modules\esbuild
        goto :fail
    )
)

rem --- 3. 設定檔 ------------------------------------------------------
rem  設定的唯一來源是 .env，由 server.mjs 自行載入；本檔只讀不寫、不帶預設值。
if not exist "%SDKUI_DIR%.env" (
    echo [3/5] 找不到設定檔 .env
    if not exist "%SDKUI_DIR%.env.example" (
        echo [錯誤] 連 .env.example 都找不到，無法建立設定檔。
        goto :fail
    )
    copy /y "%SDKUI_DIR%.env.example" "%SDKUI_DIR%.env" >nul
    if errorlevel 1 (
        echo [錯誤] 從 .env.example 建立 .env 失敗。
        goto :fail
    )
    echo.
    echo        已依 .env.example 建好一份 .env，請先確認內容再重跑本檔：
    echo          %SDKUI_DIR%.env
    echo.
    echo        特別注意：
    echo          - OA_ORIGIN 要填 server 的 API 位址，本機 dev 是 http://localhost:3000
    echo            （跟 widget 版相反：這版不載 widget.js，SDK 直接跨網域打 API）
    echo          - TENANT_ID 必填，等於 allowedOrigins 含 http://localhost:4200 的那個租戶 id
    echo          - TENANT_PK 多半在你機器上無效，要換成該租戶自己的 pk
    goto :fail
)
echo [3/5] 設定來源：%SDKUI_DIR%.env

set "DEMO_PORT="
set "OA_URL="
set "PK="
set "TID="
set "PRIV="
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"PORT=" "%SDKUI_DIR%.env"`)                do set "DEMO_PORT=%%l"
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"OA_ORIGIN=" "%SDKUI_DIR%.env"`)           do set "OA_URL=%%l"
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"TENANT_PK=" "%SDKUI_DIR%.env"`)           do set "PK=%%l"
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"TENANT_ID=" "%SDKUI_DIR%.env"`)           do set "TID=%%l"
rem  私鑰是多行 PEM，這裡只看第一行有沒有值，內容本身不在批次檔裡使用
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"TENANT_PRIVATE_KEY=" "%SDKUI_DIR%.env"`)  do set "PRIV=%%l"

rem  以下補值只服務「下面的健檢與畫面提示」，不會寫進環境變數；
rem  真正的 fallback 行為在 server.mjs 裡（PORT 預設 4200、OA_ORIGIN 預設 3000）。
if not defined DEMO_PORT set "DEMO_PORT=4200"

if not defined OA_URL (
    echo [錯誤] .env 裡的 OA_ORIGIN 是空的，本機 dev 請填 http://localhost:3000。
    goto :fail
)

rem  server.mjs 在 TENANT_ID 空白時照樣會啟動，但每張 Assertion 的 iss 都是空字串，
rem  要到點開聊天室換發時才失敗。這裡先擋。
if not defined TID (
    echo [錯誤] .env 裡的 TENANT_ID 是空的。它是 Assertion 的 iss，換發一定會失敗。
    echo        請填 allowedOrigins 含 http://localhost:%DEMO_PORT% 的那個租戶 id（後台 5174 的租戶列表可查）。
    goto :fail
)

rem --- 4. 埠與相依服務健檢 --------------------------------------------
netstat -ano | findstr "LISTENING" | findstr /c:":%DEMO_PORT% " >nul 2>nul
if not errorlevel 1 (
    echo [錯誤] 埠 %DEMO_PORT% 已被占用，請關掉占用它的程式，或改 .env 的 PORT。
    echo        注意：改埠之後，租戶的 allowedOrigins 也要跟著加上新網址，否則會被 CORS 擋。
    goto :fail
)

set "API_OK="
curl.exe -sf -o nul --max-time 3 "%OA_URL%/healthz"
if not errorlevel 1 set "API_OK=1"
if not defined API_OK echo [提醒] 取不到 %OA_URL%/healthz → API 連不上。請確認 run_server.bat 已啟動，且 .env 的 OA_ORIGIN 是 server 位址（本機 3000）。

rem  server 只存金鑰的 sha256，pk 原文只在建立租戶／補發金鑰時回傳一次，
rem  所以 .env.example 不可能內建一把在你機器上有效的 pk。這裡先驗，
rem  免得一路跑起來、打開聊天室才看到「金鑰錯誤」。
if not defined PK (
    echo [錯誤] .env 裡的 TENANT_PK 是空的。
    goto :nopk
)
if defined API_OK (
    curl.exe -sf -o nul --max-time 5 "%OA_URL%/api/widget/config?key=%PK%"
    if errorlevel 1 (
        echo [錯誤] server 不認 .env 裡的 TENANT_PK（/api/widget/config 非 200）。
        goto :nopk
    )
    echo [4/5] TENANT_PK 驗證通過；Tenant ID：%TID%
)

if not defined PRIV (
    echo.
    echo [提醒] .env 未設 TENANT_PRIVATE_KEY：server 會當場產一組金鑰並把公鑰印在下方，
    echo        要貼到後台該租戶的「Assertion 公鑰」才換發得了；重啟就換一組，得重貼。
)

echo.
echo [5/5] 啟動中，網址 http://localhost:%DEMO_PORT%  （Ctrl+C 停止）
echo        開頁後先在登入頁登入，再點右上「線上客服」開聊天室；若顯示「初始化失敗」，多半是租戶沒登記
echo        .env 私鑰對應的公鑰，或 allowedOrigins 沒含 http://localhost:%DEMO_PORT%。
echo.

rem  等 server 起來再開瀏覽器（esbuild 打包要一點時間）；不想自動開就把下一行改成註解（前面加 rem）
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:%DEMO_PORT%'"

node %STRIP% "%ROOT%\presale\sdk-custom-ui\server.mjs"
set "EXITCODE=%ERRORLEVEL%"
popd
if not "%EXITCODE%"=="0" (
    echo.
    echo [結束] node 以代碼 %EXITCODE% 結束。
    pause
)
endlocal & exit /b %EXITCODE%

:nopk
echo.
echo        server 只存金鑰的 sha256，pk 原文只在「建租戶」或「補發金鑰」時回傳一次，
echo        所以沒辦法從既有資料反查，也不可能內建在 .env.example 裡。
echo.
echo        取得方式二選一：
echo          - 後台 http://localhost:5174 建租戶，建立時會顯示一次 pk_...
echo          - 已有租戶就補發：POST /api/admin/tenants/%TID%/keys  body {"type":"publishable"}
echo.
echo        租戶條件：allowedOrigins 要含 http://localhost:%DEMO_PORT%，
echo        租戶要已登記 .env 私鑰對應的 Assertion 公鑰，且 .env 的 TENANT_ID 等於該租戶 id。詳見 docs/LOCAL-SETUP.md 第六節。
echo.
echo        拿到的 pk_... 填回 %SDKUI_DIR%.env 的 TENANT_PK。
goto :fail

:fail
echo.
popd 2>nul
pause
endlocal & exit /b 1
