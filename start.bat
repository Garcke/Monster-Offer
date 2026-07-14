@echo off
setlocal
cd /d "%~dp0"

echo Starting Monster Offer...
if exist ".venv\Scripts\python.exe" (
    ".venv\Scripts\python.exe" server.py
) else (
    python server.py
)

if errorlevel 1 (
    echo.
    echo Startup failed. Create the project environment with:
    echo uv venv --python 3.12 .venv
    echo uv pip install --python .venv\Scripts\python.exe -r requirements.txt
    pause
)
