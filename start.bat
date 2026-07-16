@echo off
setlocal
cd /d "%~dp0"

if /I "%~1"=="desktop" (
    if not exist "desktop\node_modules\.bin\electron.cmd" (
        echo Electron is not installed. Run: cd desktop ^&^& npm install
        pause
        exit /b 1
    )
    pushd desktop
    npm start
    popd
    exit /b %errorlevel%
)

echo Starting Meeting-Monster...
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
