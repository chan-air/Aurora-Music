@echo off
rem ---------------------------------------------------------------------------
rem  Aurora Music launcher.
rem  This file is ASCII-only on purpose: cmd.exe reads .cmd bytes using the
rem  current code page, so Chinese text here would show up as mojibake.
rem  All user-facing text lives in start.ps1 (UTF-8 safe).
rem ---------------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
