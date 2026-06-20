@echo off
setlocal EnableExtensions

set "MODE=%~1"
if "%MODE%"=="" set "MODE=all"
set "PDD_PORT=9222"
set "WECHAT_PORT=9333"
set "BASE_PROFILE=%LOCALAPPDATA%\DuoduoDigitalManager\chrome"
if "%BASE_PROFILE%"=="\DuoduoDigitalManager\chrome" set "BASE_PROFILE=%USERPROFILE%\.duoduo\chrome"

call :find_chrome
if not defined CHROME_EXE (
  echo [ERROR] Google Chrome was not found.
  echo.
  echo Tried common paths including:
  echo   %%LOCALAPPDATA%%\Google\Chrome\Application\chrome.exe
  echo   %%LOCALAPPDATA%%\Google\Chrome\Bin\chrome.exe
  echo   C:\Users\Administrator\AppData\Local\Google\Chrome\Bin\chrome.exe
  echo.
  echo If Chrome is installed elsewhere, run:
  echo   set "MAO_CHROME_PATH=C:\path\to\chrome.exe"
  echo   %~nx0
  exit /b 1
)

echo [OK] Chrome: "%CHROME_EXE%"
echo.

if /i "%MODE%"=="all" (
  call :start_service "PDD" "%PDD_PORT%" "%BASE_PROFILE%\pdd-chrome" "https://mc.pinduoduo.com/ddmc-mms/order/management"
  call :start_service "WeChat" "%WECHAT_PORT%" "%BASE_PROFILE%\wechat-chrome" "https://wx.qq.com/"
  goto :done
)

if /i "%MODE%"=="pdd" (
  call :start_service "PDD" "%PDD_PORT%" "%BASE_PROFILE%\pdd-chrome" "https://mc.pinduoduo.com/ddmc-mms/order/management"
  goto :done
)

if /i "%MODE%"=="wechat" (
  call :start_service "WeChat" "%WECHAT_PORT%" "%BASE_PROFILE%\wechat-chrome" "https://wx.qq.com/"
  goto :done
)

echo [ERROR] Unknown mode: %MODE%
echo Usage:
echo   %~nx0
echo   %~nx0 pdd
echo   %~nx0 wechat
exit /b 1

:done
echo.
echo PDD Chrome URL:    http://127.0.0.1:%PDD_PORT%
echo WeChat Chrome URL: http://127.0.0.1:%WECHAT_PORT%
echo.
echo Keep these Chrome windows open while the desktop app is running.
exit /b 0

:find_chrome
call :try_chrome "%MAO_CHROME_PATH%"
call :try_chrome "%PDD_CHROME_PATH%"
call :try_chrome "%CHROME_PATH%"
call :try_chrome "%GOOGLE_CHROME_BIN%"

call :try_chrome "%PROGRAMFILES%\Google\Chrome\Application\chrome.exe"
call :try_chrome "%PROGRAMFILES%\Google\Chrome\Bin\chrome.exe"
call :try_chrome "%PROGRAMFILES(X86)%\Google\Chrome\Application\chrome.exe"
call :try_chrome "%PROGRAMFILES(X86)%\Google\Chrome\Bin\chrome.exe"
call :try_chrome "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
call :try_chrome "%LOCALAPPDATA%\Google\Chrome\Bin\chrome.exe"
call :try_chrome "%USERPROFILE%\AppData\Local\Google\Chrome\Application\chrome.exe"
call :try_chrome "%USERPROFILE%\AppData\Local\Google\Chrome\Bin\chrome.exe"
call :try_chrome "C:\Users\Administrator\AppData\Local\Google\Chrome\Application\chrome.exe"
call :try_chrome "C:\Users\Administrator\AppData\Local\Google\Chrome\Bin\chrome.exe"
call :try_chrome "%SystemDrive%\Users\Administrator\AppData\Local\Google\Chrome\Application\chrome.exe"
call :try_chrome "%SystemDrive%\Users\Administrator\AppData\Local\Google\Chrome\Bin\chrome.exe"

if not defined CHROME_EXE call :chrome_from_registry "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
if not defined CHROME_EXE call :chrome_from_registry "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
if not defined CHROME_EXE call :chrome_from_registry "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"

if not defined CHROME_EXE (
  for /f "delims=" %%I in ('where.exe chrome.exe 2^>nul') do (
    if not defined CHROME_EXE call :try_chrome "%%I"
  )
)
exit /b 0

:chrome_from_registry
for /f "tokens=2,*" %%A in ('reg.exe query "%~1" /ve 2^>nul ^| findstr /i "REG_"') do (
  if not defined CHROME_EXE call :try_chrome "%%B"
)
exit /b 0

:try_chrome
if defined CHROME_EXE exit /b 0
set "CANDIDATE=%~1"
if not defined CANDIDATE exit /b 0
set "CANDIDATE=%CANDIDATE:"=%"
if exist "%CANDIDATE%" (
  if /i "%CANDIDATE:~-4%"==".exe" (
    set "CHROME_EXE=%CANDIDATE%"
    exit /b 0
  )
)
if exist "%CANDIDATE%\chrome.exe" (
  set "CHROME_EXE=%CANDIDATE%\chrome.exe"
  exit /b 0
)
if exist "%CANDIDATE%\Application\chrome.exe" (
  set "CHROME_EXE=%CANDIDATE%\Application\chrome.exe"
  exit /b 0
)
if exist "%CANDIDATE%\Bin\chrome.exe" (
  set "CHROME_EXE=%CANDIDATE%\Bin\chrome.exe"
  exit /b 0
)
exit /b 0

:start_service
set "LABEL=%~1"
set "PORT=%~2"
set "PROFILE_DIR=%~3"
set "OPEN_URL=%~4"

call :port_listening "%PORT%"
if not errorlevel 1 (
  echo [%LABEL%] Port %PORT% is already listening. Reusing it.
  exit /b 0
)

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%" >nul 2>nul
echo [%LABEL%] Starting Chrome on port %PORT% ...
start "%LABEL% Chrome %PORT%" "%CHROME_EXE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE_DIR%" --no-first-run --no-default-browser-check "%OPEN_URL%"
exit /b 0

:port_listening
netstat -ano -p tcp 2>nul | findstr /r /c:":%~1 .*LISTENING" >nul 2>nul
exit /b %ERRORLEVEL%
