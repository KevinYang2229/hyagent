@echo off
rem =====================================================================
rem  HyAgent presale demo：模擬租戶網站（widget 浮動按鈕 + SSO 免登入）
rem  位置：presale\widge-tenant\run_tenant.bat
rem  用法：直接雙擊，或從任何目錄執行本檔
rem  設定：一律來自同目錄 .env（本檔不帶任何預設值）
rem  相依：先跑 run_server.bat（API）與 run_client.bat（提供 widget.js）
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

set "TENANT_DIR=%~dp0"
pushd "%~dp0..\.." || goto :fail
set "ROOT=%CD%"

echo.
echo =====================================================
echo   HyAgent 模擬租戶網站  presale/widge-tenant
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
:deps
if exist "%ROOT%\node_modules\@hyagent\sdk\package.json" (
    echo [2/5] 相依套件已就緒
) else (
    echo [2/5] 缺少 @hyagent/sdk workspace 連結，執行 npm install ...
    call npm install
    if errorlevel 1 (
        echo [錯誤] npm install 失敗，請手動到 repo 根目錄執行 npm install。
        goto :fail
    )
    if not exist "%ROOT%\node_modules\@hyagent\sdk\package.json" (
        echo [錯誤] npm install 跑完，但仍找不到 node_modules\@hyagent\sdk
        goto :fail
    )
)

rem --- 3. 設定檔 ------------------------------------------------------
rem  設定的唯一來源是 .env，由 server.mjs 自行載入；本檔只讀不寫、不帶預設值。
if not exist "%TENANT_DIR%.env" (
    echo [3/5] 找不到設定檔 .env
    if not exist "%TENANT_DIR%.env.example" (
        echo [錯誤] 連 .env.example 都找不到，無法建立設定檔。
        goto :fail
    )
    copy /y "%TENANT_DIR%.env.example" "%TENANT_DIR%.env" >nul
    if errorlevel 1 (
        echo [錯誤] 從 .env.example 建立 .env 失敗。
        goto :fail
    )
    echo.
    echo        已依 .env.example 建好一份 .env，請先確認內容再重跑本檔：
    echo          %TENANT_DIR%.env
    echo.
    echo        特別注意 OA_ORIGIN：要填「提供 widget.js 的 client dev server」
    echo        本機 dev 通常是 http://localhost:5173，不是 server 的 3000；
    echo        server 的 API 位址請填在 OA_API_ORIGIN。
    goto :fail
)
echo [3/5] 設定來源：%TENANT_DIR%.env

set "DEMO_PORT="
set "OA_URL="
set "API_URL="
set "PK="
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"PORT=" "%TENANT_DIR%.env"`)           do set "DEMO_PORT=%%l"
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"OA_ORIGIN=" "%TENANT_DIR%.env"`)      do set "OA_URL=%%l"
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"OA_API_ORIGIN=" "%TENANT_DIR%.env"`)  do set "API_URL=%%l"
for /f "usebackq tokens=1,* delims==" %%k in (`findstr /b /c:"TENANT_PK=" "%TENANT_DIR%.env"`)      do set "PK=%%l"

rem  以下兩個補值只服務「下面的健檢與畫面提示」，不會寫進環境變數；
rem  真正的 fallback 行為在 server.mjs 裡（PORT 預設 4000、API 預設沿用 OA_ORIGIN）。
if not defined DEMO_PORT set "DEMO_PORT=4000"
if not defined API_URL   set "API_URL=%OA_URL%"

rem --- 4. 埠與相依服務健檢 --------------------------------------------
netstat -ano | findstr "LISTENING" | findstr /c:":%DEMO_PORT% " >nul 2>nul
if not errorlevel 1 (
    echo [錯誤] 埠 %DEMO_PORT% 已被占用，請關掉占用它的程式，或改 .env 的 PORT。
    goto :fail
)

if defined OA_URL (
    curl.exe -sf -o nul --max-time 3 "%OA_URL%/sdk/widget.js"
    if errorlevel 1 echo [提醒] 取不到 %OA_URL%/sdk/widget.js → widget 會載不進來。請確認 run_client.bat 已啟動，且 .env 的 OA_ORIGIN 指向 client dev server。
)

set "API_OK="
if defined API_URL (
    curl.exe -sf -o nul --max-time 3 "%API_URL%/healthz"
    if not errorlevel 1 set "API_OK=1"
)
if not defined API_OK echo [提醒] 取不到 %API_URL%/healthz → API 連不上。請確認 run_server.bat 已啟動，且 .env 的 OA_API_ORIGIN 正確。

rem  server 只存金鑰的 sha256，pk 原文只在建立租戶／補發金鑰時回傳一次，
rem  所以 .env.example 不可能內建一把在你機器上有效的 pk。這裡先驗，
rem  免得一路跑起來、點開 widget 才看到「金鑰錯誤」。
if not defined PK (
    echo [錯誤] .env 裡的 TENANT_PK 是空的。
    goto :nopk
)
if defined API_OK (
    curl.exe -sf -o nul --max-time 5 "%API_URL%/api/widget/config?key=%PK%"
    if errorlevel 1 (
        echo [錯誤] server 不認 .env 裡的 TENANT_PK（/api/widget/config 非 200）。
        goto :nopk
    )
    echo [4/5] TENANT_PK 驗證通過
)

echo.
echo [5/5] 啟動中，網址 http://localhost:%DEMO_PORT%  （Ctrl+C 停止）
echo.

rem  等 server 起來再開瀏覽器；不想自動開就把下一行改成註解（前面加 rem）
start "" /min powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%DEMO_PORT%'"

node %STRIP% "%ROOT%\presale\widge-tenant\server.mjs"
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
echo          - 已有租戶就補發：POST /api/admin/tenants/{id}/keys  body {"type":"publishable"}
echo.
echo        租戶條件：allowedOrigins 要含 http://localhost:%DEMO_PORT%，
echo        租戶要已登記本站印出的 Assertion 公鑰，且 .env 的 TENANT_ID 等於該租戶 id。詳見 docs/LOCAL-SETUP.md 第六節。
echo.
echo        拿到的 pk_... 填回 %TENANT_DIR%.env 的 TENANT_PK。
goto :fail

:fail
echo.
popd 2>nul
pause
endlocal & exit /b 1
