@echo off
title Eagle Viewer [Debug]
cd /d "%~dp0viewer"
python serve.py
pause
