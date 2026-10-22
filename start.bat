@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 栖 Roost

rem ============================================================
rem  找 node，按优先级：
rem    1. 系统 PATH
rem    2. 环境变量 NODE_EXE
rem    3. 同目录 node-path.txt（本机临时指定，删掉即恢复默认）
rem    4. 同目录 node\node.exe（便携版）
rem ============================================================
set "NODE_CMD="
for %%p in (node.exe) do if not defined NODE_CMD if not "%%~$PATH:p"=="" set "NODE_CMD=%%~$PATH:p"
if not defined NODE_CMD if defined NODE_EXE if exist "%NODE_EXE%" set "NODE_CMD=%NODE_EXE%"
if not defined NODE_CMD if exist "%~dp0node-path.txt" for /f "usebackq delims=" %%p in ("%~dp0node-path.txt") do if not defined NODE_CMD set "NODE_CMD=%%p"
if not defined NODE_CMD if exist "%~dp0node\node.exe" set "NODE_CMD=%~dp0node\node.exe"
if not defined NODE_CMD goto :no_node

rem ---- 版本检查交给 node 自己算，避免在批处理里解析版本号 ----
"%NODE_CMD%" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto :old_node

rem ---- 启动 ----
"%NODE_CMD%" src/main.js %*
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo 程序异常退出，代码 %CODE%
  echo 排查日志: logs\bot.log
)

pause
exit /b %CODE%

:no_node
echo.
echo [错误] 没有找到 Node.js
echo.
echo 本项目需要 Node.js 22 或更高版本，它不是能免安装运行的独立程序。
echo 请去 https://nodejs.org/ 下载 LTS 版本安装，安装时勾选 Add to PATH，
echo 装完关掉这个窗口重新双击 start.bat。
echo.
echo 如果已经装了但不在 PATH 里，可以在本目录建一个 node-path.txt，
echo 里面写一行 node.exe 的完整路径，例如：
echo   C:\Program Files\nodejs\node.exe
echo.
pause
exit /b 1

:old_node
echo.
echo [错误] Node.js 版本太低
echo 当前使用的 node: %NODE_CMD%
"%NODE_CMD%" -v
echo 需要 22 或更高，请去 https://nodejs.org/ 装一个 LTS 版本。
echo.
pause
exit /b 1
