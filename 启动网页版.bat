@echo off
chcp 65001  > nul  & rem 设置代码页为UTF-8
"%~dp0env\python.exe" "%~dp0main_server.py" --open-browser --page api_key

REM ------------ 启动两个服务（附着在同一控制台） ----------
echo.
echo 正在启动服务器...
start "Memory Server" /B "%~dp0env\python.exe" "%~dp0memory_server.py" --enable-shutdown
timeout /t 10 > nul
"%~dp0env\python.exe" "%~dp0main_server.py" --open-browser --page index
