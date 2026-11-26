@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=8964"
set "RUST_PROXY_PORT=8965"
set "RUST_PROXY_BIN=rust-proxy\target\release\anti-proxy.exe"
set "PID_DIR=%USERPROFILE%\.anti-api"
set "ANTI_API_PID=%PID_DIR%\anti-api.pid"
set "RUST_PID_FILE=%PID_DIR%\rust-proxy.pid"
set "SETTINGS_FILE=%PID_DIR%\settings.json"
set "AUTO_RESTART=false"
set "ANTI_API_PATTERN=anti-api|src/main\.ts|bun(\.exe)?"
set "RUST_PROXY_PATTERN=anti-proxy|rust-proxy"

if not exist "%PID_DIR%" mkdir "%PID_DIR%" >nul 2>&1
if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%USERPROFILE%\.bun\bin;%PATH%"

echo Anti-API
echo.

set "DO_UPDATE=false"
set "UPDATE_ONLY=false"
for %%A in (%*) do (
    if /I "%%~A"=="--update" set "DO_UPDATE=true"
    if /I "%%~A"=="-u" set "DO_UPDATE=true"
    if /I "%%~A"=="--update-only" (
        set "DO_UPDATE=true"
        set "UPDATE_ONLY=true"
    )
)

if "%DO_UPDATE%"=="true" call :update_release || goto :error
if "%UPDATE_ONLY%"=="true" goto :eof

where bun >nul 2>&1
if errorlevel 1 (
    echo Bun not found. Installing...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://bun.sh/install.ps1 | iex"
    if errorlevel 1 goto :error
    if exist "%USERPROFILE%\.bun\bin\bun.exe" set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
)

where ngrok >nul 2>&1
if errorlevel 1 (
    echo ngrok not found. Downloading...
    set "NGROK_ZIP=%TEMP%\ngrok-v3-stable-windows-amd64.zip"
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri 'https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile '%NGROK_ZIP%'"
    if errorlevel 1 goto :error
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%NGROK_ZIP%' -DestinationPath '%~dp0ngrok-temp' -Force"
    if errorlevel 1 goto :error
    move /Y "%~dp0ngrok-temp\ngrok.exe" "%~dp0ngrok.exe" >nul
    rmdir /S /Q "%~dp0ngrok-temp" >nul 2>&1
    del "%NGROK_ZIP%" >nul 2>&1
)

if exist "%SETTINGS_FILE%" (
    for /f %%V in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $data = Get-Content '%SETTINGS_FILE%' -Raw | ConvertFrom-Json; if ($data.autoRestart) { 'true' } else { 'false' } } catch { 'false' }"') do set "AUTO_RESTART=%%V"
)

call :cleanup_existing_processes

echo Building Rust proxy...
bun x tsc >nul
if errorlevel 1 goto :error
cargo build --release --manifest-path rust-proxy/Cargo.toml
if errorlevel 1 goto :error

if not exist "%RUST_PROXY_BIN%" (
    echo Rust proxy binary not found.
    goto :error
)

echo Starting Rust proxy...
set "RUST_PID="
for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$wd=[System.IO.Directory]::GetCurrentDirectory(); $p=Start-Process -FilePath '%RUST_PROXY_BIN%' -WorkingDirectory $wd -PassThru -WindowStyle Hidden; $p.Id"') do set "RUST_PID=%%P"
if not defined RUST_PID (
    echo Failed to start Rust proxy.
    goto :error
)
>%RUST_PID_FILE% echo !RUST_PID!

echo Starting Anti-API on http://localhost:%PORT%
echo.

:api_loop
call :run_api_once
set "API_EXIT=!ERRORLEVEL!"
if "!AUTO_RESTART!"=="true" (
    if not "!API_EXIT!"=="0" if not "!API_EXIT!"=="130" if not "!API_EXIT!"=="143" (
        echo Anti-API exited with code !API_EXIT!. Restarting in 2 seconds...
        timeout /t 2 /nobreak >nul
        goto :api_loop
    )
)

    if not "!API_EXIT!"=="0" if not "!API_EXIT!"=="130" if not "!API_EXIT!"=="143" goto :error
    goto :shutdown

:run_api_once
set "API_PID="
for /f %%P in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$wd=[System.IO.Directory]::GetCurrentDirectory(); $p=Start-Process -FilePath 'bun' -ArgumentList @('run','src/main.ts','start') -WorkingDirectory $wd -PassThru -NoNewWindow; $p.Id"') do set "API_PID=%%P"
if not defined API_PID (
    echo Failed to start Anti-API.
    exit /b 1
)
>%ANTI_API_PID% echo !API_PID!
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Get-Process -Id !API_PID! -ErrorAction Stop; $p.WaitForExit(); exit $p.ExitCode"
set "API_EXIT=!ERRORLEVEL!"
del "%ANTI_API_PID%" >nul 2>&1
exit /b !API_EXIT!

:cleanup_existing_processes
if exist "%ANTI_API_PID%" (
    set /p OLD_ANTI_PID=<"%ANTI_API_PID%"
    call :safe_kill_pid "!OLD_ANTI_PID!" "%ANTI_API_PATTERN%"
    del "%ANTI_API_PID%" >nul 2>&1
)
if exist "%RUST_PID_FILE%" (
    set /p OLD_RUST_PID=<"%RUST_PID_FILE%"
    call :safe_kill_pid "!OLD_RUST_PID!" "%RUST_PROXY_PATTERN%"
    del "%RUST_PID_FILE%" >nul 2>&1
)
call :safe_kill_by_port "%PORT%" "%ANTI_API_PATTERN%"
call :safe_kill_by_port "%RUST_PROXY_PORT%" "%RUST_PROXY_PATTERN%"
exit /b 0

:safe_kill_by_port
set "TARGET_PORT=%~1"
set "TARGET_PATTERN=%~2"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%TARGET_PORT% .*LISTENING"') do (
    call :safe_kill_pid "%%P" "%TARGET_PATTERN%"
)
exit /b 0

:safe_kill_pid
set "TARGET_PID=%~1"
set "TARGET_PATTERN=%~2"
if not defined TARGET_PID exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$pid=%TARGET_PID%;" ^
  "$pattern='%TARGET_PATTERN%';" ^
  "$proc=Get-CimInstance Win32_Process -Filter \"ProcessId = $pid\" -ErrorAction SilentlyContinue;" ^
  "if(-not $proc){ exit 0 }" ^
  "$cmd=[string]$proc.CommandLine; $name=[string]$proc.Name;" ^
  "if($cmd -match $pattern -or $name -match $pattern){ Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue }"
exit /b 0

:update_release
if /I "%ANTI_API_PACKAGE_MANAGER%"=="winget" (
    echo This installation is managed by WinGet. Run: winget upgrade anti-api
    exit /b 0
)
if "%ANTI_API_NO_SELF_UPDATE%"=="1" (
    echo Self-update is disabled for this installation.
    exit /b 0
)
set "TMPDIR=%TEMP%\anti-api-update"
set "ZIP=%TMPDIR%\anti-api.zip"
set "HASHFILE=%TMPDIR%\anti-api.zip.sha256"
set "ZIPURL="
set "HASHURL="
set "EXPECTED="

if exist "%TMPDIR%" rmdir /S /Q "%TMPDIR%" >nul 2>&1
mkdir "%TMPDIR%" >nul 2>&1

echo Checking latest release...
for /f "usebackq delims=" %%L in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$r=Invoke-RestMethod -Headers @{ 'User-Agent'='anti-api-updater' } -Uri 'https://api.github.com/repos/silasxbt/anti-api/releases/latest'; foreach($a in $r.assets){ if($a.name -eq 'anti-api-portable.zip'){ $a.browser_download_url }; if($a.name -eq 'anti-api-portable.zip.sha256'){ $a.browser_download_url } }"`) do (
    if not defined ZIPURL (
        set "ZIPURL=%%L"
    ) else if not defined HASHURL (
        set "HASHURL=%%L"
    )
)

if not defined ZIPURL (
    echo Latest release zip asset not found.
    exit /b 1
)
if not defined HASHURL (
    echo Latest release checksum asset not found.
    exit /b 1
)

echo Downloading release...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Headers @{ 'User-Agent'='anti-api-updater' } -Uri '%ZIPURL%' -OutFile '%ZIP%'"
if errorlevel 1 exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Headers @{ 'User-Agent'='anti-api-updater' } -Uri '%HASHURL%' -OutFile '%HASHFILE%'"
if errorlevel 1 exit /b 1

for /f "usebackq tokens=1" %%H in (`type "%HASHFILE%"`) do set "EXPECTED=%%H"
if not defined EXPECTED (
    echo Failed to read checksum.
    exit /b 1
)

for /f %%H in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-FileHash '%ZIP%' -Algorithm SHA256).Hash.ToLowerInvariant()"') do set "ACTUAL=%%H"
if /I not "%ACTUAL%"=="%EXPECTED%" (
    echo Checksum mismatch.
    echo Expected: %EXPECTED%
    echo Actual:   %ACTUAL%
    exit /b 1
)

echo Applying update...
set "EXTRACT=%TMPDIR%\extract"
mkdir "%EXTRACT%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%EXTRACT%' -Force"
if errorlevel 1 exit /b 1

set "SRC=%EXTRACT%\anti-api-portable"
if not exist "%SRC%" set "SRC=%EXTRACT%"

robocopy "%SRC%" "%CD%" /E /NFL /NDL /NJH /NJS /NC /NS >nul
set "ROBO=%ERRORLEVEL%"
if %ROBO% GEQ 8 (
    echo Update copy failed.
    exit /b 1
)

echo Update complete.
exit /b 0

:shutdown
if exist "%RUST_PID_FILE%" (
    set /p OLD_RUST_PID=<"%RUST_PID_FILE%"
    call :safe_kill_pid "!OLD_RUST_PID!" "%RUST_PROXY_PATTERN%"
    del "%RUST_PID_FILE%" >nul 2>&1
)
call :safe_kill_by_port "%RUST_PROXY_PORT%" "%RUST_PROXY_PATTERN%"
exit /b 0

:error
call :shutdown
echo.
echo Startup failed.
if not "%ANTI_API_NO_PAUSE%"=="1" pause
exit /b 1
