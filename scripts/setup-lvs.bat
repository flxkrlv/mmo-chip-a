@echo off
REM setup-lvs.bat — Install vyges-lvs on a fresh machine
REM Run this from the repo root after `git clone` and `npm install`.

echo === vyges-lvs setup ===
echo.

REM Check if vyges-lvs already exists
where vyges-lvs >nul 2>nul
if %errorlevel% equ 0 (
    echo vyges-lvs already installed at:
    where vyges-lvs
    goto :done
)

REM Try prebuilt binary (not available for Windows yet)
echo No vyges-lvs found. Installing Rust toolchain + building from source...
echo.

REM Check if Rust is installed
where rustc >nul 2>nul
if %errorlevel% neq 0 (
    echo Rust not found. Installing rustup...
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o "%TEMP%\rustup-init.exe"
    "%TEMP%\rustup-init.exe" -y --default-toolchain stable --profile minimal
    call "%USERPROFILE%\.cargo\cargo_env"
) else (
    echo Rust already installed.
)

echo Installing vyges-lvs (this will take 3-10 minutes)...
call cargo install --git https://github.com/vyges-tools/lvs

if %errorlevel% neq 0 (
    echo.
    echo ERROR: vyges-lvs build failed.
    echo On Windows you may need to switch to the GNU toolchain:
    echo   rustup toolchain install stable-x86_64-pc-windows-gnu
    echo   rustup default stable-x86_64-pc-windows-gnu
    echo Then re-run this script.
    exit /b 1
)

:done
echo.
echo === Setup complete ===
echo vyges-lvs is ready. Start the backend with:
echo   cd backend ^&^& npm run dev
echo.
echo To verify manually:
echo   vyges-lvs --version
