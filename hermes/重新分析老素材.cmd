@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo  Hermes：老爆款素材重新分析（补齐记忆维度）
echo  标题/开头文案/全文案/爆款要点/画面标题/封面/情绪
echo  已补齐的会自动跳过，只跑缺的
echo ============================================
echo.
set PY=<USER_HOME>\AppData\Local\Programs\Python\Python311\python.exe
if not exist "%PY%" set PY=python
"%PY%" scripts\reanalyze-hits.py
echo.
echo 跑完了，回 GLB 的 Hermes 记忆页刷新即可看到新维度。
pause
