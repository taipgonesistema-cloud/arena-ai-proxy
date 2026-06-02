@echo off
setlocal

echo.
echo  ╔══════════════════════════════════════╗
echo  ║   Building arena-launcher.exe        ║
echo  ╚══════════════════════════════════════╝
echo.

cd /d "%~dp0"
set "APP_DIR=%~dp0appzaofoda"
set "APP_EXE=%APP_DIR%\arena-launcher.exe"
set "APP_ICON=%APP_DIR%\mainico.ico"
if not exist "%APP_ICON%" set "APP_ICON=%APP_DIR%\arena-launcher.ico"
set "RCEDIT_DIR=%TEMP%\arena-launcher-rcedit"
set "RCEDIT_EXE=%RCEDIT_DIR%\node_modules\rcedit\bin\rcedit-x64.exe"
if not exist "%APP_DIR%" mkdir "%APP_DIR%"

echo  [1] Syntax check...
node --check arena-launcher.cjs
if errorlevel 1 (
    echo  ERROR: Syntax error in arena-launcher.cjs
    pause
    exit /b 1
)
echo       OK

echo  [2] Generating SEA blob...
node --experimental-sea-config sea-config.json
if errorlevel 1 (
    echo  ERROR: Failed to generate SEA blob
    pause
    exit /b 1
)
echo       OK — sea-prep.blob created

echo  [3] Copying node.exe as base...
taskkill /F /IM arena-launcher.exe >nul 2>&1
if exist "%APP_EXE%" del "%APP_EXE%"
copy /y "%~dp0node_modules\.cache\node.exe" "%APP_EXE%" >nul 2>&1
if not exist "%APP_EXE%" (
    where node >nul 2>&1
    if errorlevel 1 (
        echo  ERROR: node.exe not found
        pause
        exit /b 1
    )
    for /f "delims=" %%i in ('where node') do (
        copy /y "%%i" "%APP_EXE%" >nul
        goto :copied
    )
)
:copied
if not exist "%APP_EXE%" (
    echo  ERROR: Failed to copy node.exe
    pause
    exit /b 1
)
echo       OK — arena-launcher.exe created from node.exe

echo  [4] Applying icon...
if exist "%APP_ICON%" (
    if not exist "%RCEDIT_EXE%" (
        npm install rcedit --prefix "%RCEDIT_DIR%" --no-audit --no-fund
    )
    "%RCEDIT_EXE%" "%APP_EXE%" --set-icon "%APP_ICON%"
    if errorlevel 1 (
        echo  WARNING: failed to apply icon
    ) else (
        echo       Icon applied: %APP_ICON%
    )
) else (
    echo       icon not found — skipping
)

echo  [5] Injecting SEA blob into exe...
npx --yes postject "%APP_EXE%" NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
if errorlevel 1 (
    echo  ERROR: postject failed
    pause
    exit /b 1
)
echo       OK — blob injected

echo  [6] Removing code signature (optional)...
where signtool >nul 2>&1
if not errorlevel 1 (
    signtool remove /s "%APP_EXE%" >nul 2>&1
    echo       Signature removed
) else (
    echo       signtool not found — skipping (exe may show SmartScreen warning)
)

echo.
echo  ══════════════════════════════════════════
echo   BUILD COMPLETE: appzaofoda\arena-launcher.exe
echo   Double-click it to launch everything.
echo  ══════════════════════════════════════════
echo.

:: Cleanup
del sea-prep.blob 2>nul

pause
