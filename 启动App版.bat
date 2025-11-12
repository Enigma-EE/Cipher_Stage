@echo off
chcp 65001  > nul  & rem 设置代码页为UTF-8

REM 使用预设好的API地址（统一为48921端口）
set API_BASE_URL="http://localhost:48921/"
echo API地址: %API_BASE_URL%

REM ------------ 启动两个服务（附着在同一控制台） ----------
echo.
echo 正在启动服务器...
start "Memory Server" /B "%~dp0env\python.exe" "%~dp0memory_server.py"
start "Main Server" /B "%~dp0env\python.exe" "%~dp0main_server.py"

REM ------------ 打开测试页 ----------
echo.
timeout /t 5 /nobreak >nul

start "" "%~dp0EE_client.exe"

echo.
echo 服务器运行中……
REM ------------ 启动 EE_client.exe（附着在同一控制台） ----------

:loop
timeout /t 3600 >nul
goto loop

:fail
echo [错误] 启动失败
pause
goto :eof