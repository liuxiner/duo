@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "ROOT_DIR=%%~fI"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=all"
set "PDD_PORT=9222"
set "WECHAT_PORT=9333"
set "BASE_PROFILE=%LOCALAPPDATA%\DuoduoDigitalManager\chrome"
if "%BASE_PROFILE%"=="\DuoduoDigitalManager\chrome" set "BASE_PROFILE=%USERPROFILE%\.duoduo\chrome"

if not defined MAO_USE_DESKTOP_WECHAT call :load_env_value MAO_USE_DESKTOP_WECHAT
if not defined MAO_WECHAT_CHANNEL call :load_env_value MAO_WECHAT_CHANNEL
if not defined MAO_WECHAT_EXE_PATH call :load_env_value MAO_WECHAT_EXE_PATH
call :detect_desktop_wechat_mode

if /i "%MODE%"=="wechat" if defined USE_DESKTOP_WECHAT goto :after_chrome_check

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

:after_chrome_check
if defined USE_DESKTOP_WECHAT echo [OK] WeChat App channel enabled.
if defined USE_DESKTOP_WECHAT echo.

if /i "%MODE%"=="all" (
  call :start_service "PDD" "%PDD_PORT%" "%BASE_PROFILE%\pdd-chrome" "https://mc.pinduoduo.com/ddmc-mms/order/management"
  if defined USE_DESKTOP_WECHAT (
    call :start_wechat_app
    if errorlevel 1 exit /b 1
  ) else (
    call :start_service "WeChat" "%WECHAT_PORT%" "%BASE_PROFILE%\wechat-chrome" "https://wx.qq.com/"
  )
  goto :done
)

if /i "%MODE%"=="pdd" (
  call :start_service "PDD" "%PDD_PORT%" "%BASE_PROFILE%\pdd-chrome" "https://mc.pinduoduo.com/ddmc-mms/order/management"
  goto :done
)

if /i "%MODE%"=="wechat" (
  if defined USE_DESKTOP_WECHAT (
    call :start_wechat_app
    if errorlevel 1 exit /b 1
  ) else (
    call :start_service "WeChat" "%WECHAT_PORT%" "%BASE_PROFILE%\wechat-chrome" "https://wx.qq.com/"
  )
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
if defined USE_DESKTOP_WECHAT (
  echo WeChat App:        %WECHAT_EXE%
) else (
  echo WeChat Chrome URL: http://127.0.0.1:%WECHAT_PORT%
)
echo.
echo Keep these windows open while the desktop app is running.
exit /b 0

:load_env_value
if not exist "%ROOT_DIR%\.env" exit /b 0
for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT_DIR%\.env") do (
  if /i "%%A"=="%~1" if not defined %~1 set "%~1=%%~B"
)
exit /b 0

:detect_desktop_wechat_mode
set "USE_DESKTOP_WECHAT="
if /i "%MAO_WECHAT_CHANNEL%"=="desktop_wechat" set "USE_DESKTOP_WECHAT=1"
if /i "%MAO_WECHAT_CHANNEL%"=="wechat_app" set "USE_DESKTOP_WECHAT=1"
if /i "%MAO_WECHAT_CHANNEL%"=="app" set "USE_DESKTOP_WECHAT=1"
if /i "%MAO_USE_DESKTOP_WECHAT%"=="1" set "USE_DESKTOP_WECHAT=1"
if /i "%MAO_USE_DESKTOP_WECHAT%"=="true" set "USE_DESKTOP_WECHAT=1"
if /i "%MAO_USE_DESKTOP_WECHAT%"=="yes" set "USE_DESKTOP_WECHAT=1"
if /i "%MAO_USE_DESKTOP_WECHAT%"=="on" set "USE_DESKTOP_WECHAT=1"
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

:find_wechat
call :try_wechat "%MAO_WECHAT_EXE_PATH%"
call :try_wechat "%PROGRAMFILES%\Tencent\Weixin\Weixin.exe"
call :try_wechat "%PROGRAMFILES%\Tencent\WeChat\WeChat.exe"
call :try_wechat "%PROGRAMFILES(X86)%\Tencent\Weixin\Weixin.exe"
call :try_wechat "%PROGRAMFILES(X86)%\Tencent\WeChat\WeChat.exe"
call :try_wechat "%LOCALAPPDATA%\Tencent\Weixin\Weixin.exe"
call :try_wechat "%LOCALAPPDATA%\Tencent\WeChat\WeChat.exe"
call :try_wechat "%LOCALAPPDATA%\Programs\Tencent\Weixin\Weixin.exe"
call :try_wechat "%LOCALAPPDATA%\Programs\Tencent\WeChat\WeChat.exe"
call :try_wechat "%LOCALAPPDATA%\Microsoft\WindowsApps\Weixin.exe"
call :try_wechat "%LOCALAPPDATA%\Microsoft\WindowsApps\WeChat.exe"

if not defined WECHAT_EXE call :wechat_from_registry "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe"
if not defined WECHAT_EXE call :wechat_from_registry "HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\WeChat.exe"
if not defined WECHAT_EXE call :wechat_from_registry "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe"
if not defined WECHAT_EXE call :wechat_from_registry "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WeChat.exe"
if not defined WECHAT_EXE call :wechat_from_registry "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Weixin.exe"
if not defined WECHAT_EXE call :wechat_from_registry "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\WeChat.exe"

if not defined WECHAT_EXE (
  for /f "delims=" %%I in ('where.exe Weixin.exe 2^>nul') do (
    if not defined WECHAT_EXE call :try_wechat "%%I"
  )
)
if not defined WECHAT_EXE (
  for /f "delims=" %%I in ('where.exe WeChat.exe 2^>nul') do (
    if not defined WECHAT_EXE call :try_wechat "%%I"
  )
)
exit /b 0

:wechat_from_registry
for /f "tokens=2,*" %%A in ('reg.exe query "%~1" /ve 2^>nul ^| findstr /i "REG_"') do (
  if not defined WECHAT_EXE call :try_wechat "%%B"
)
exit /b 0

:try_wechat
if defined WECHAT_EXE exit /b 0
set "CANDIDATE=%~1"
if not defined CANDIDATE exit /b 0
set "CANDIDATE=%CANDIDATE:"=%"
if exist "%CANDIDATE%" (
  if /i "%CANDIDATE:~-4%"==".exe" (
    set "WECHAT_EXE=%CANDIDATE%"
    exit /b 0
  )
)
exit /b 0

:start_wechat_app
call :find_wechat
if not defined WECHAT_EXE (
  echo [ERROR] Desktop WeChat was not found.
  echo.
  echo Set MAO_WECHAT_EXE_PATH to the full path of Weixin.exe or WeChat.exe, then retry:
  echo   set "MAO_WECHAT_EXE_PATH=C:\path\to\Weixin.exe"
  exit /b 1
)
echo [WeChat] Starting desktop WeChat app: "%WECHAT_EXE%"
start "WeChat App" "%WECHAT_EXE%"
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
