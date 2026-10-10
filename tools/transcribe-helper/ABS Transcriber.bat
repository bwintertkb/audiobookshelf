@echo off
rem Starts the ABS Transcriber app (no console window). Setup: see README.md, "Transcriber app".
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0transcriber_app.py"
