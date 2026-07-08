@echo off
if "%HOST%"=="" set HOST=0.0.0.0
if "%PORT%"=="" set PORT=8000
if "%COMPLETION_IQ_DATA_DIR%"=="" set COMPLETION_IQ_DATA_DIR=%~dp0backend
python "%~dp0backend\server.py"
