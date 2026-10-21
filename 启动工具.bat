@echo off
rem ===========================================================================
rem  ZHILING 2D avatar asset workbench - root launcher (Windows)
rem  - double-click to start tools\seq_asset_tool\start.bat
rem  - forwards extra args, e.g.  start_tool.bat --force-new
rem ===========================================================================
setlocal EnableExtensions
title ZHILING 2D Avatar Workbench
cd /d "%~dp0"

if not exist "tools\seq_asset_tool\start.bat" (
    echo [ERROR] tools\seq_asset_tool\start.bat not found.
    echo         Please keep this file in the repository root.
    pause
    exit /b 1
)

call "tools\seq_asset_tool\start.bat" %*
exit /b %ERRORLEVEL%
