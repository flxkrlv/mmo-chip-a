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
    
    # Update PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    
} else {
    Write-Host "Rust already installed at: $($rustc.Source)" -ForegroundColor Green
}

# Add cargo to PATH
$cargoPath = "$env:USERPROFILE\.cargo\bin"
if ($env:Path -notlike "*$cargoPath*") {
    $env:Path = "$cargoPath;$env:Path"
}

Write-Host ""
Write-Host "Installing vyges-lvs (this will take 3-10 minutes)..." -ForegroundColor Yellow
Write-Host ""

cargo install --git https://github.com/vyges-tools/lvs

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "ERROR: vyges-lvs build failed." -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Common fixes for Windows:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "1. Install Visual Studio Build Tools:" -ForegroundColor White
    Write-Host "   https://visualstudio.microsoft.com/visual-cpp-build-tools/"
    Write-Host "   (Select 'Desktop development with C++' workload)"
    Write-Host ""
    Write-Host "2. Or try the GNU toolchain:" -ForegroundColor White
    Write-Host "   rustup toolchain install stable-x86_64-pc-windows-gnu"
    Write-Host "   rustup default stable-x86_64-pc-windows-gnu"
    Write-Host ""
    Write-Host "3. Then re-run this script."
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "vyges-lvs is ready. Start the backend with:" -ForegroundColor White
Write-Host "  cd backend; npm run dev"
Write-Host ""
Write-Host "To verify manually:" -ForegroundColor White
Write-Host "  vyges-lvs --version"
Write-Host ""
Read-Host "Press Enter to exit"