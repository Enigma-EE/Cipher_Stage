@echo off
chcp 65001  > nul  & rem 设置代码页为UTF-8

echo.
echo 正在启动服务器...
"%~dp0env\python.exe" "%~dp0main_server.py" --open-browser --page chara_manager