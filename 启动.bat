@echo off
chcp 65001 >nul 2>&1
setlocal
cd /d "%~dp0"

:: ===============================================================
::  Butler AI - double-click launcher
:: ===============================================================
::
::  Purpose: let people who do not use a terminal still run this
::  project. Checks Node and deps, installs what is missing, then
::  hands off to `bin/butler.mjs web`.
::
::  -----------------------------------------------------------------
::  WHY THIS FILE IS 100%% ASCII
::  -----------------------------------------------------------------
::  cmd.exe reads a .bat line by line while the OEM codepage is
::  active, and it does so BEFORE `chcp 65001` takes effect for the
::  rest of the file. With Chinese text in here that produced:
::
::      '???' is not recognized as an internal or external command
::      '??-??' is not recognized as an internal or external command
::
::  Three attempts to fix it by moving `chcp` around and saving as
::  CRLF + UTF-8 without BOM all still failed intermittently. That
::  is the worst kind of failure: it depends on where the
::  multi-byte boundaries happen to land, so it looks random.
::
::  So: NO non-ASCII bytes live in this file at all. Every Chinese
::  string the user sees is printed by `bin/butler.mjs`, where Node
::  handles UTF-8 correctly. Keep it that way.
::  -----------------------------------------------------------------
::
::  Why the last line is `pause`: a double-clicked .bat closes its
::  window on exit, so without it an error flashes by and the user
::  only sees "it blinked" with no idea what went wrong.
:: ===============================================================

node "bin\butler.mjs" launcher-check
if errorlevel 1 (
  echo.
  echo   Setup could not complete. See the message above.
  echo.
  pause
  exit /b 1
)

node "bin\butler.mjs" web
set EXITCODE=%errorlevel%

echo.
pause
exit /b %EXITCODE%
