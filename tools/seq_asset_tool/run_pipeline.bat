@echo off
setlocal
cd /d "%~dp0"
rem 优先使用工作台「安装依赖（.venv）」创建的虚拟环境，其次用 PATH 里的 python
set "PYTHON=%~dp0.venv\Scripts\python.exe"
if not exist "%PYTHON%" set "PYTHON=python"
"%PYTHON%" "%~dp0run_pipeline.py" %*
exit /b %ERRORLEVEL%
