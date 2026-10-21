@echo off
rem Compatibility entry: start.cmd now forwards to start.bat.
call "%~dp0start.bat" %*
exit /b %errorlevel%
