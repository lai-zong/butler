@echo off
cd /d "%~dp0"
set "BUTLER_URL=http://127.0.0.1:3000"
start "" pythonw scripts\desktop_pet.py
