# vyges-lvs SPICE Syntax Test Harness
# Tests 11 different SPICE netlist syntax patterns

param(
    [string]$VygesBin = "C:\Users\user\.cargo\bin\vyges-lvs.exe"
)

$ErrorActionPreference = "Stop"
$testCount = 0
$passCount = 0
$failCount = 0
$results = @()

function New-TempDir {
    $path = Join-Path $env:TEMP "vyges_syntax_test_$(Get-Random)"
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}

function Remove-TempDir {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Run-Test {
    param(
        [string]$Name,
        [string]$LayoutContent,
        [string]$SchematicContent,
        [switch]$ExpectMatch
    )

    $script:testCount++
    Write-Host ("=" * 72)
    Write-Host ("[{0}] {1}" -f $script:testCount, $Name) -ForegroundColor Cyan
    Write-Host ("-" * 72)

    $tmpDir = New-TempDir
    $layoutFile = Join-Path $tmpDir "layout.spice"
    $schematicFile = Join-Path $tmpDir "schematic.spice"
    $jobFile = Join-Path $tmpDir "job.lvs"
    $jsonOut = Join-Path $tmpDir "result.json"

    try {
        # Write netlist files
        $LayoutContent | Set-Content -LiteralPath $layoutFile -NoNewline
        $SchematicContent | Set-Content -LiteralPath $schematicFile -NoNewline

        # Get top-level cell from layout (first .SUBCKT or .subckt)
        $topCell = ""
        if ($LayoutContent -match '\.(?:SUBCKT|subckt)\s+(\w+)') {
            $topCell = $matches[1]
        }

        # Write job file
        $jobContent = "layout: $layoutFile`nschematic: $schematicFile`ntop: $topCell"
        $jobContent | Set-Content -LiteralPath $jobFile -NoNewline

        # Display netlist content
        Write-Host "  Layout:" -ForegroundColor DarkYellow
        ($LayoutContent -split "`n") | ForEach-Object { Write-Host ("    | {0}" -f $_) }
        Write-Host "  Schematic:" -ForegroundColor DarkYellow
        ($SchematicContent -split "`n") | ForEach-Object { Write-Host ("    | {0}" -f $_) }
        Write-Host ("  Top cell: [{0}]" -f $topCell) -ForegroundColor DarkGray

        # Run vyges-lvs
        Write-Host "  Running: vyges-lvs run job.lvs --json" -ForegroundColor DarkGray
        $output = & $VygesBin run $jobFile --json -o $jsonOut 2>&1
        $exitCode = $LASTEXITCODE

        if (Test-Path -LiteralPath $jsonOut) {
            $rawJson = Get-Content -LiteralPath $jsonOut -Raw
            $json = $rawJson | ConvertFrom-Json
            Write-Host ("  Exit code: {0}" -f $exitCode) -ForegroundColor DarkGray
            Write-Host "  JSON result:" -ForegroundColor Green
            Write-Host ("    {0}" -f $rawJson.Trim())

            $matched = $json.matched
            if ($matched -eq $true) {
                Write-Host "  >> MATCHED" -ForegroundColor Green
                if ($ExpectMatch) { $script:passCount++ } else { $script:failCount++ }
            } else {
                Write-Host "  >> MISMATCHED" -ForegroundColor Red
                if (-not $ExpectMatch) { $script:passCount++ } else { $script:failCount++ }
            }
            return @{ Name = $Name; Status = if ($matched) {"MATCH"} else {"MISMATCH"}; Json = $json; ExitCode = $exitCode }
        } else {
            Write-Host "  >> ERROR (no JSON output)" -ForegroundColor Red
            Write-Host "  stderr/stdout: $output" -ForegroundColor Red
            $script:failCount++
            return @{ Name = $Name; Status = "ERROR"; Output = "$output"; ExitCode = $exitCode }
        }
    } catch {
        Write-Host "  >> EXCEPTION: $_" -ForegroundColor Red
        $script:failCount++
        return @{ Name = $Name; Status = "EXCEPTION"; Error = "$_" }
    } finally {
        Remove-TempDir $tmpDir
    }
}

# ============================================================
# TEST 1: CDL basic
# ============================================================
Write-Host ""
$r1 = Run-Test -Name "CDL basic (.SUBCKT/.ENDS, R C Q D on one line)" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 1k
Q1 n1 n2 n3 npn
C1 n1 n2 1p
D1 n1 n2 diode
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 1k
Q1 n1 n2 n3 npn
C1 n1 n2 1p
D1 n1 n2 diode
.ENDS
"@ `
    -ExpectMatch
$script:results += $r1

# ============================================================
# TEST 2: CDL with model names
# ============================================================
$r2 = Run-Test -Name "CDL with model names (RES_GEN, NPN_GEN)" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 RES_GEN 1k
Q1 n1 n2 n3 NPN_GEN
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 RES_GEN 1k
Q1 n1 n2 n3 NPN_GEN
.ENDS
"@ `
    -ExpectMatch
$script:results += $r2

# ============================================================
# TEST 3: CDL with m factor
# ============================================================
$r3 = Run-Test -Name "CDL with m=3.6 (fractional m factor)" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 1k m=3.6
Q1 n1 n2 n3 npn m=3.6
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 1k m=3.6
Q1 n1 n2 n3 npn m=3.6
.ENDS
"@ `
    -ExpectMatch
$script:results += $r3

# ============================================================
# TEST 4: CDL with expressions
# ============================================================
$r4 = Run-Test -Name "CDL with .PARAM expressions (19.9*Rbase)" `
    -LayoutContent @"
.PARAM Rbase=150
.SUBCKT test n1 n2
R1 n1 n2 19.9*Rbase
.ENDS
"@ `
    -SchematicContent @"
.PARAM Rbase=150
.SUBCKT test n1 n2
R1 n1 n2 19.9*Rbase
.ENDS
"@ `
    -ExpectMatch
$script:results += $r4

# ============================================================
# TEST 5: CDL with .GLOBAL
# ============================================================
$r5 = Run-Test -Name "CDL with .GLOBAL (VCC, GND)" `
    -LayoutContent @"
.GLOBAL VCC GND
.SUBCKT test n1 n2 VCC GND
R1 n1 VCC 1k
R2 n2 GND 1k
.ENDS
"@ `
    -SchematicContent @"
.GLOBAL VCC GND
.SUBCKT test n1 n2 VCC GND
R1 n1 VCC 1k
R2 n2 GND 1k
.ENDS
"@ `
    -ExpectMatch
$script:results += $r5

# ============================================================
# TEST 6: Spectre basic (.subckt with parenthesized ports)
# ============================================================
$r6 = Run-Test -Name "Spectre basic (.subckt (ports), resistor r=1k)" `
    -LayoutContent @"
.subckt test (n1 n2 n3)
R1 (n1 n2) resistor r=1k
C1 (n2 n3) capacitor c=1p
.ends test
"@ `
    -SchematicContent @"
.subckt test (n1 n2 n3)
R1 (n1 n2) resistor r=1k
C1 (n2 n3) capacitor c=1p
.ends test
"@ `
    -ExpectMatch
$script:results += $r6

# ============================================================
# TEST 7: Spectre with lang directive
# ============================================================
$r7 = Run-Test -Name "Spectre with simulator lang=spectre + .subckt" `
    -LayoutContent @"
simulator lang=spectre
.subckt test (n1 n2 n3)
R1 (n1 n2) resistor r=1k
.ends test
"@ `
    -SchematicContent @"
simulator lang=spectre
.subckt test (n1 n2 n3)
R1 (n1 n2) resistor r=1k
.ends test
"@ `
    -ExpectMatch
$script:results += $r7

# ============================================================
# TEST 8: CDL-Spectre hybrid (.SUBCKT wrapper, Spectre device)
# ============================================================
$r8 = Run-Test -Name "CDL-Spectre hybrid (.SUBCKT + spectre device syntax)" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 resistor r=1k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 resistor r=1k
.ENDS
"@ `
    -ExpectMatch
$script:results += $r8

# ============================================================
# TEST 9: Spectre with parameters
# ============================================================
$r9 = Run-Test -Name "Spectre with parameters inside .subckt" `
    -LayoutContent @"
.subckt test (n1 n2)
parameters Rbase=150
R1 (n1 n2) resistor r=19.9*Rbase
.ends test
"@ `
    -SchematicContent @"
.subckt test (n1 n2)
parameters Rbase=150
R1 (n1 n2) resistor r=19.9*Rbase
.ends test
"@ `
    -ExpectMatch
$script:results += $r9

# ============================================================
# TEST 10: BJT with 4 terminals
# ============================================================
$r10 = Run-Test -Name "BJT 4-terminal (collector base emitter substrate)" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3 n4
Q1 n1 n2 n3 n4 npn
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3 n4
Q1 n1 n2 n3 n4 npn
.ENDS
"@ `
    -ExpectMatch
$script:results += $r10

# ============================================================
# TEST 11: Diode model name mismatch
# ============================================================
$r11 = Run-Test -Name "Diode model name mismatch (diode vs mymodel)" `
    -LayoutContent @"
.SUBCKT test n1 n2
D1 n1 n2 diode
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2
D1 n1 n2 mymodel
.ENDS
"@ `
    -ExpectMatch:$false
$script:results += $r11

# ============================================================
# SUMMARY
# ============================================================
Write-Host ("=" * 72)
Write-Host "SUMMARY" -ForegroundColor Cyan
Write-Host ("=" * 72)
$tc = $testCount
$pc = $passCount
$fc = $failCount
Write-Host ("Total:  {0}" -f $tc)
$passColor = if ($pc -eq $tc) { "Green" } else { "Yellow" }
$failColor = if ($fc -eq 0) { "Green" } else { "Red" }
Write-Host ("Passed: {0}" -f $pc) -ForegroundColor $passColor
Write-Host ("Failed: {0}" -f $fc) -ForegroundColor $failColor

# Return structured results as JSON
$script:results | ConvertTo-Json -Depth 5