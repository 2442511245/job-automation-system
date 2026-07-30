@echo off
chcp 65001 >nul
title 求职自动化系统 - 启动中...

echo.
echo ============================================
echo    🤖 求职自动化与数据分析系统
echo    BOSS直聘全自动打招呼 + AI 智能匹配
echo ============================================
echo.

:: 检查 Python 是否安装
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Python，请先安装 Python 3.10+
    echo    下载地址：https://www.python.org/downloads/
    echo    ⚠️ 安装时务必勾选 "Add Python to PATH"
    echo.
    pause
    exit /b 1
)

echo ✅ Python 已就绪
echo.

:: 自动安装依赖
echo 📦 正在检查/安装依赖库...
pip install -r "%~dp0requirements.txt" -i https://pypi.tuna.tsinghua.edu.cn/simple --quiet 2>&1
if %errorlevel% neq 0 (
    echo ⚠️ 自动安装失败，尝试备用源...
    pip install -r "%~dp0requirements.txt" --quiet 2>&1
)

echo ✅ 依赖库就绪
echo.

:: 检查环境变量
if "%FLASK_SECRET_KEY%"=="" (
    echo ⚠️ 未设置 FLASK_SECRET_KEY，本次将自动生成随机密钥
    echo    （如需固定密钥，请在 .env 文件中设置 FLASK_SECRET_KEY）
)

:: 启动 Flask 后端
echo 🚀 正在启动后端服务...
echo.
echo ╔══════════════════════════════════════════╗
echo ║  服务启动后，请打开浏览器访问：          ║
echo ║  http://localhost:5000                  ║
echo ║                                        ║
echo ║  如果浏览器没有自动打开，请手动输入↑    ║
echo ╚══════════════════════════════════════════╝
echo.

:: 延迟 2 秒后自动打开浏览器
start "" /b cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:5000"

:: 启动应用
cd /d "%~dp0"
python app.py

:: 如果应用退出了
echo.
echo ⚠️ 服务已停止。按任意键关闭窗口...
pause >nul
