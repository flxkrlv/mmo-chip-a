# setup-lvs.ps1
Write-Host "=== vyges-lvs setup ===" -ForegroundColor Cyan
Write-Host ""

# Check if vyges-lvs already exists
$existing = Get-Command vyges-lvs -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "vyges-lvs already installed at:" -ForegroundColor Green
    Write-Host $existing.Source
    Read-Host "Press Enter to exit"
    exit 0
}

Write-Host "No vyges-lvs found. Installing Rust toolchain + building from source..." -ForegroundColor Yellow
Write-Host ""

# Check if Rust is installed
$rustc = Get-Command rustc -ErrorAction SilentlyContinue
if (-not $rustc) {
    Write-Host "Rust not found. Installing rustup..." -ForegroundColor Yellow
    
    $rustupPath = "$env:TEMP\rustup-init.exe"
    
    # Download
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Write-Host "Downloading rustup-init.exe..." -ForegroundColor Yellow
        Invoke-WebRequest -Uri "https://win.rustup.rs" -OutFile $rustupPath -UseBasicParsing
        Write-Host "Download completed!" -ForegroundColor Green
    } catch {
        Write-Host "Failed to download rustup: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ""
        Write-Host "Please download manually from: https://win.rustup.rs" -ForegroundColor Yellow
        Write-Host "Save as: $rustupPath"
        Write-Host "Then run this script again."
        Read-Host "Press Enter to exit"
        exit 1
    }
    
    Write-Host "Running rustup installer..." -ForegroundColor Yellow
    & $rustupPath -y --default-toolchain stable --profile minimal
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Rust installation failed." -ForegroundColor Red
        Write-Host "Please try installing manually from https://rustup.rs/" -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }
    
    Write-Host "Rust installed successfully!" -ForegroundColor Green
    
    # Update PATH for current session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
} else {
    Write-Host "Rust already installed at: $($rustc.Source)" -ForegroundColor Green
}

# Add cargo to PATH if not already there
$cargoPath = "$env:USERPROFILE\.cargo\bin"
if ($env:Path -notlike "*$cargoPath*") {
    $env:Path = "$cargoPath;$env:Path"
}

# ============================================================
# INSTALL GNU TOOLCHAIN (to avoid MSVC linker dependency)
# ============================================================
Write-Host ""
Write-Host "Setting up GNU toolchain for Windows (no Visual Studio required)..." -ForegroundColor Yellow
Write-Host ""

# Check if GNU toolchain is already installed
$gnuInstalled = rustup toolchain list | Select-String "stable-x86_64-pc-windows-gnu"

if (-not $gnuInstalled) {
    Write-Host "Installing GNU toolchain (stable-x86_64-pc-windows-gnu)..." -ForegroundColor Yellow
    rustup toolchain install stable-x86_64-pc-windows-gnu
    
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to install GNU toolchain." -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "GNU toolchain installed successfully!" -ForegroundColor Green
} else {
    Write-Host "GNU toolchain already installed." -ForegroundColor Green
}

# Set GNU as default
Write-Host "Setting GNU toolchain as default..." -ForegroundColor Yellow
rustup default stable-x86_64-pc-windows-gnu

if ($LASTEXITCODE -ne 0) {
    Write-Host "Failed to set GNU toolchain as default." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Verify
Write-Host "Verifying Rust installation..." -ForegroundColor Yellow
rustc --version
cargo --version
Write-Host ""

# ============================================================
# INSTALL VYGES-LVS
# ============================================================
Write-Host "Installing vyges-lvs (this will take 3-10 minutes)..." -ForegroundColor Yellow
Write-Host ""

cargo install --git https://github.com/vyges-tools/lvs

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "ERROR: vyges-lvs build failed." -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Possible issues:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "1. Make sure you have Git installed:" -ForegroundColor White
    Write-Host "   https://git-scm.com/download/win"
    Write-Host ""
    Write-Host "2. Make sure you have GNU toolchain properly installed:" -ForegroundColor White
    Write-Host "   rustup toolchain list"
    Write-Host "   Should show: stable-x86_64-pc-windows-gnu (default)"
    Write-Host ""
    Write-Host "3. Try restarting your terminal and run this script again."
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# ============================================================
# DONE
# ============================================================
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "=== SETUP COMPLETE ===" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "vyges-lvs is ready to use!" -ForegroundColor White
Write-Host ""
Write-Host "To start the backend:" -ForegroundColor Yellow
Write-Host "  cd backend" -ForegroundColor White
Write-Host "  npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "To verify vyges-lvs:" -ForegroundColor Yellow
Write-Host "  vyges-lvs --version" -ForegroundColor White
Write-Host ""
Read-Host "Press Enter to exit"