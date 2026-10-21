@echo off
rem ===========================================================================
rem  seq_asset_tool launcher (Windows)
rem  - starts the local server in this console and opens the workbench page
rem  - closing this window or pressing Ctrl+C stops the server
rem ===========================================================================
setlocal EnableExtensions
title 2D Seq Asset Workbench
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [seq-asset-tool] Node.js not found. Please install Node.js 18+ : https://nodejs.org/
    echo.
    pause
    exit /b 1
)

set "NODE_MAJOR="
for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
if defined NODE_MAJOR set "NODE_MAJOR=%NODE_MAJOR:v=%"

if not defined NODE_MAJOR (
    echo [seq-asset-tool] Unable to read the Node.js version. Please check your installation.
    echo.
    pause
    exit /b 1
)

if %NODE_MAJOR% LSS 18 (
    echo [seq-asset-tool] Node.js v%NODE_MAJOR%.x is too old; Node.js 18+ is required.
    echo.
    pause
    exit /b 1
)

echo [seq-asset-tool] Starting local server and opening the workbench page...
echo [seq-asset-tool] Stop the server: press Ctrl+C or close this window.
echo.

node server.mjs --open --watch-parent
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo.
    echo [seq-asset-tool] Server exited with code %EXITCODE%.
    pause
)

endlocal & exit /b %EXITCODE%
