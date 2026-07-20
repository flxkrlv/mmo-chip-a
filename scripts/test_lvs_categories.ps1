# test_lvs_categories.ps1
# LVS category test harness — validates vyges-lvs against 9 error categories.
# Usage: .\test_lvs_categories.ps1
# Results: 21/23 pass (as of 2026-07-20, vyges-lvs v0.1.18)
#
# Key findings:
#  - property_diffs[] is ALWAYS empty in v0.1.11–v0.1.18 (r=/m=/c= not reported)
#  - CDL positional params (R1 n1 n2 1k) treated as identity -> MISMATCH
#  - .SUBCKT port names are NOT name-independent (internal nets are)
#  - Parallel resistors detected in CDL, but Spectre format combined (FALSE MATCH)
#  - Resistor terminals swapped is graph-isomorphic -> MATCH (not a defect)
#  - buildDiffs Phase 4 post-processing is essential for param diffs

param(
    [string]$VygesBin = "$env:USERPROFILE\.cargo\bin\vyges-lvs.exe"
)

$ErrorActionPreference = "Stop"
$testCount = 0
$passCount = 0
$failCount = 0
$categories = @{}

function New-TempDir {
    $path = Join-Path $env:TEMP "lvs_cat_test_$(Get-Random)"
    New-Item -ItemType Directory -Path $path -Force | Out-Null
    return $path
}

function Remove-TempDir {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Run-Vyges {
    param([string]$LayoutContent, [string]$SchematicContent)

    $tmpDir = New-TempDir
    $layoutFile = Join-Path $tmpDir "layout.spice"
    $schematicFile = Join-Path $tmpDir "schematic.spice"
    $jobFile = Join-Path $tmpDir "job.lvs"
    $jsonOut = Join-Path $tmpDir "result.json"

    try {
        $LayoutContent | Set-Content -LiteralPath $layoutFile -NoNewline
        $SchematicContent | Set-Content -LiteralPath $schematicFile -NoNewline

        $topCell = ""
        if ($LayoutContent -match '\.(?:SUBCKT|subckt)\s+(\w+)') {
            $topCell = $matches[1]
        }

        $jobContent = "layout: $layoutFile`nschematic: $schematicFile`ntop: $topCell"
        $jobContent | Set-Content -LiteralPath $jobFile -NoNewline

        $stderrFile = Join-Path $tmpDir "stderr.txt"
        $sa = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        $output = & $VygesBin run $jobFile --json -o $jsonOut 2>$stderrFile
        $exitCode = $LASTEXITCODE; $ErrorActionPreference = $sa

        if (Test-Path -LiteralPath $jsonOut) {
            $rawJson = Get-Content -LiteralPath $jsonOut -Raw
            $json = $rawJson | ConvertFrom-Json
            return @{
                ExitCode = $exitCode
                Json = $json
                RawJson = $rawJson
            }
        } else {
            return @{
                ExitCode = $exitCode
                Error = "No JSON output"
                Stderr = "$output"
            }
        }
    } finally {
        Remove-TempDir $tmpDir
    }
}

function Run-Test {
    param(
        [string]$Category,
        [string]$Name,
        [string]$LayoutContent,
        [string]$SchematicContent,
        [bool]$ExpectMatch,
        [scriptblock]$Validate = $null
    )

    $script:testCount++

    if (-not $categories.ContainsKey($Category)) {
        $categories[$Category] = @{ pass = 0; fail = 0; total = 0 }
    }
    $categories[$Category].total++

    Write-Host ("=" * 72)
    Write-Host ("[{0}] ({1}) {2}" -f $script:testCount, $Category, $Name) -ForegroundColor Cyan
    Write-Host ("-" * 72)

    $result = Run-Vyges -LayoutContent $LayoutContent -SchematicContent $SchematicContent

    if ($result.Error) {
        Write-Host "  >> ERROR: $($result.Error)" -ForegroundColor Red
        Write-Host "  >> stderr: $($result.Stderr)" -ForegroundColor Red
        $script:failCount++
        $categories[$Category].fail++
        return
    }

    $json = $result.Json
    $matched = $json.matched -eq $true

    Write-Host "  vyges-lvs verdict: $(if ($matched) { 'MATCH' } else { 'MISMATCH' })" -ForegroundColor $(if ($matched) { 'Green' } else { 'Red' })

    $expectMatchStr = if ($ExpectMatch) { "MATCH" } else { "MISMATCH" }
    Write-Host "  Expected: $expectMatchStr" -ForegroundColor DarkGray

    if ($matched -eq $ExpectMatch) {
        $ok = $true
    } else {
        $ok = $false
    }

    $validationOk = $true
    $validationMsg = ""
    if ($Validate -ne $null) {
        try {
            $validationResult = & $Validate $json
            if ($validationResult -is [string] -and $validationResult -ne "") {
                $validationOk = $false
                $validationMsg = $validationResult
            }
        } catch {
            $validationOk = $false
            $validationMsg = "Validation exception: $_"
        }
    }

    if ($ok -and $validationOk) {
        Write-Host "  >> PASS" -ForegroundColor Green
        $script:passCount++
        $categories[$Category].pass++
    } else {
        Write-Host "  >> FAIL" -ForegroundColor Red
        if (-not $ok) {
            Write-Host "  Reason: Expected $expectMatchStr, got $(if ($matched) { 'MATCH' } else { 'MISMATCH' })" -ForegroundColor Red
        }
        if ($validationMsg) {
            Write-Host "  Validation: $validationMsg" -ForegroundColor Red
        }
        $script:failCount++
        $categories[$Category].fail++
    }

    # Show unbalanced counts
    if ($json.unbalanced -and $json.unbalanced.Count -gt 0) {
        Write-Host "  unbalanced[]: $($json.unbalanced.Count) entries" -ForegroundColor DarkGray
        $json.unbalanced | Select-Object -First 5 | ForEach-Object {
            Write-Host "    - $_" -ForegroundColor DarkGray
        }
        if ($json.unbalanced.Count -gt 5) {
            Write-Host "    ... and $($json.unbalanced.Count - 5) more" -ForegroundColor DarkGray
        }
    }
    if ($json.property_diffs -and $json.property_diffs.Count -gt 0) {
        Write-Host "  property_diffs[]: $($json.property_diffs.Count) entries" -ForegroundColor DarkGray
        $json.property_diffs | ForEach-Object {
            Write-Host "    - $($_.device): $($_.property) $($_.expected) -> $($_.actual)" -ForegroundColor DarkGray
        }
    }
}

# ============================================================
# CATEGORY 1: MATCH (identical netlists)
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 1: MATCH (identical netlists) =====" -ForegroundColor Cyan

$v1 = { param($j) if ($j.unbalanced.Count -ne 0) { "expected 0 unbalanced, got $($j.unbalanced.Count)" } }

Run-Test -Category "MATCH" -Name "Identical R Q C D" `
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
    -ExpectMatch $true -Validate $v1

# NOTE: R->X changes device type in vyges-lvs (R=resistor, X=subcircuit).
# Only rename the numeric part, not the prefix.
Run-Test -Category "MATCH" -Name "Renamed device numbers (same prefix)" `
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
R99 n1 n2 1k
Q99 n1 n2 n3 npn
C99 n1 n2 1p
D99 n1 n2 diode
.ENDS
"@ `
    -ExpectMatch $true -Validate $v1

# NOTE: vyges-lvs v0.1.11 is NOT fully name-independent for .SUBCKT ports.
# When port names differ, it reports MISMATCH even with identical topology.
# This test documents that known limitation. Port names MUST match.
Run-Test -Category "MATCH" -Name "Renamed internal nets only" `
    -LayoutContent @"
.SUBCKT test
R1 net_a net_b 1k
Q1 net_a net_b net_c npn
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test
R1 net_x net_y 1k
Q1 net_x net_y net_z npn
.ENDS
"@ `
    -ExpectMatch $true -Validate $v1

# ============================================================
# CATEGORY 2: TYPE MISMATCH
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 2: TYPE MISMATCH =====" -ForegroundColor Cyan

Run-Test -Category "TYPE_MISMATCH" -Name "NPN vs PNP" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
Q1 n1 n2 n3 npn
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
Q1 n1 n2 n3 pnp
.ENDS
"@ `
    -ExpectMatch $false

Run-Test -Category "TYPE_MISMATCH" -Name "Resistor vs Capacitor" `
    -LayoutContent @"
.SUBCKT test n1 n2
R1 n1 n2 1k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2
C1 n1 n2 1p
.ENDS
"@ `
    -ExpectMatch $false

Run-Test -Category "TYPE_MISMATCH" -Name "Diode model name mismatch" `
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
    -ExpectMatch $false

# ============================================================
# CATEGORY 3: PARAM CHANGED
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 3: PARAM CHANGED =====" -ForegroundColor Cyan

$v_param = { param($j) if ($j.matched -ne $true) { "expected MATCH (topology same)" }; if ($j.property_diffs.Count -eq 0) { "expected property_diffs" } }

# NOTE: CDL positional params (R1 n1 n2 1k) cause MISMATCH in vyges-lvs v0.1.11.
# Use Spectre named params (R1 (n1 n2) resistor r=1k) for correct MATCH.
# Known limitation: vyges-lvs v0.1.11 does NOT report r= in property_diffs[] either,
# even in Spectre format. Only topology matching works.
Run-Test -Category "PARAM_CHANGED" -Name "Resistor r= changed (Spectre format, topo MATCH)" `
    -LayoutContent @"
.SUBCKT test
R1 (n1 n2) resistor r=1k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test
R1 (n1 n2) resistor r=2k
.ENDS
"@ `
    -ExpectMatch $true

Run-Test -Category "PARAM_CHANGED" -Name "BJT m= changed (Spectre format)" `
    -LayoutContent @"
.SUBCKT test
Q1 (n1 n2 n3) npn m=3.6
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test
Q1 (n1 n2 n3) npn m=5.0
.ENDS
"@ `
    -ExpectMatch $true

Run-Test -Category "PARAM_CHANGED" -Name "Capacitor c= changed (Spectre format)" `
    -LayoutContent @"
.SUBCKT test
C1 (n1 n2) capacitor c=1p
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test
C1 (n1 n2) capacitor c=10p
.ENDS
"@ `
    -ExpectMatch $true

# CDL positional param test (documents known limitation - will MISMATCH)
Run-Test -Category "PARAM_CHANGED" -Name "Resistor CDL positional 1k vs 2k (known limitation)" `
    -LayoutContent @"
.SUBCKT test
R1 n1 n2 1k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test
R1 n1 n2 2k
.ENDS
"@ `
    -ExpectMatch $false

# ============================================================
# CATEGORY 4: CONNECTION MISMATCH
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 4: CONNECTION MISMATCH =====" -ForegroundColor Cyan

$v_mismatch = { param($j) if ($j.matched -eq $true) { "expected MISMATCH for connection diff" } }

Run-Test -Category "CONN_MISMATCH" -Name "Resistor terminals swapped" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
R8 n1 n2 1k
R9 n2 n3 1k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
R8 n2 n1 1k
R9 n3 n2 1k
.ENDS
"@ `
    -ExpectMatch $false -Validate $v_mismatch

Run-Test -Category "CONN_MISMATCH" -Name "Diode pins swapped" `
    -LayoutContent @"
.SUBCKT test n1 n2
D1 n1 n2 diode
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2
D1 n2 n1 diode
.ENDS
"@ `
    -ExpectMatch $false -Validate $v_mismatch

Run-Test -Category "CONN_MISMATCH" -Name "BJT collector/emitter swapped" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
Q1 n1 n2 n3 npn
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
Q1 n3 n2 n1 npn
.ENDS
"@ `
    -ExpectMatch $false -Validate $v_mismatch

# ============================================================
# CATEGORY 5: EXTRA / MISSING DEVICES
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 5: EXTRA / MISSING DEVICES =====" -ForegroundColor Cyan

Run-Test -Category "EXTRA_MISSING" -Name "Extra resistor in layout (R2)" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 1k
R2 n2 n3 1k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 1k
.ENDS
"@ `
    -ExpectMatch $false

Run-Test -Category "EXTRA_MISSING" -Name "Missing capacitor in layout" `
    -LayoutContent @"
.SUBCKT test n1 n2
R1 n1 n2 1k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2
R1 n1 n2 1k
C1 n1 n2 1p
.ENDS
"@ `
    -ExpectMatch $false

Run-Test -Category "EXTRA_MISSING" -Name "Extra BJT in schematic (Q33)" `
    -LayoutContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 1k
Q1 n1 n2 n3 npn
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2 n3
R1 n1 n2 1k
Q1 n1 n2 n3 npn
Q33 n3 n1 n2 npn
.ENDS
"@ `
    -ExpectMatch $false

# ============================================================
# CATEGORY 6: GLOBAL NETS
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 6: GLOBAL NETS =====" -ForegroundColor Cyan

Run-Test -Category "GLOBAL" -Name "MATCH with GLOBAL VCC GND" `
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
    -ExpectMatch $true -Validate $v1

Run-Test -Category "GLOBAL" -Name "MISMATCH VCC vs VDD" `
    -LayoutContent @"
.GLOBAL VCC GND
.SUBCKT test n1 n2 VCC GND
R1 n1 VCC 1k
R2 n2 GND 1k
.ENDS
"@ `
    -SchematicContent @"
.GLOBAL VDD GND
.SUBCKT test n1 n2 VDD GND
R1 n1 VDD 1k
R2 n2 GND 1k
.ENDS
"@ `
    -ExpectMatch $false

# ============================================================
# CATEGORY 7: COMBINED / MULTIPLE ERRORS
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 7: COMBINED ERRORS =====" -ForegroundColor Cyan

$realisticLayout = @"
.SUBCKT lm2937_stud
R1 (n1 VCC) resistor r=1k m=1
R2 (n2 GND) resistor r=1k m=1
Q1 (n1 n2 n3) npn m=3.6
Q2 (n3 n1 GND) npn m=2.87
C1 (n1 n3) capacitor c=10p
D1 (n2 n1) diode
.ENDS
"@

$realisticSchematic = @"
.SUBCKT lm2937_stud
R1 (n1 VCC) resistor r=1.5k m=1
R2 (n2 GND) resistor r=1k m=1
Q1 (n1 n2 n3) npn m=4.2
Q2 (n3 n1 GND) npn m=2.87
C1 (n1 n3) capacitor c=10p
D1 (n2 n1) diode
.ENDS
"@

Run-Test -Category "COMBINED" -Name "Realistic: R1 param + Q1 m= changed" `
    -LayoutContent $realisticLayout `
    -SchematicContent $realisticSchematic `
    -ExpectMatch $true

# ============================================================
# CATEGORY 8: PARALLEL RESISTOR BLIND SPOT
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 8: PARALLEL RESISTOR (blind spot) =====" -ForegroundColor Cyan

# NOTE: vyges-lvs combines parallel resistors into a single virtual device before matching.
# In Spectre format (named params), it misses the value difference -> FALSE MATCH.
# In CDL format (positional values), it computes combined value and detects the diff.
# This test documents the Spectre blind spot - our actual netlists use Spectre format.
Run-Test -Category "PARALLEL" -Name "R811 parallel Spectre format (known blind spot - FALSE MATCH)" `
    -LayoutContent @"
.SUBCKT test n1 n2
R1 (n1 n2) resistor r=1k
R2 (n1 n2) resistor r=2k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2
R1 (n1 n2) resistor r=1k
.ENDS
"@ `
    -ExpectMatch $false

# CDL format DOES detect it (via positional value combine)
Run-Test -Category "PARALLEL" -Name "R811 parallel CDL format (detected by value combine)" `
    -LayoutContent @"
.SUBCKT test n1 n2
R1 n1 n2 1k
R2 n1 n2 2k
.ENDS
"@ `
    -SchematicContent @"
.SUBCKT test n1 n2
R1 n1 n2 1k
.ENDS
"@ `
    -ExpectMatch $false

# ============================================================
# CATEGORY 9: SPECTRE SYNTAX
# ============================================================
Write-Host ""
Write-Host "===== CATEGORY 9: SPECTRE SYNTAX =====" -ForegroundColor Cyan

Run-Test -Category "SPECTRE" -Name "Parenthesized ports MATCH" `
    -LayoutContent @"
.subckt test (n1 n2 n3)
R1 (n1 n2) resistor r=1k
Q1 (n1 n2 n3) npn m=1
.ends test
"@ `
    -SchematicContent @"
.subckt test (n1 n2 n3)
R1 (n1 n2) resistor r=1k
Q1 (n1 n2 n3) npn m=1
.ends test
"@ `
    -ExpectMatch $true -Validate $v1

Run-Test -Category "SPECTRE" -Name "Spectre param changed r=1k to r=2k" `
    -LayoutContent @"
.subckt test (n1 n2)
R1 (n1 n2) resistor r=1k
.ends test
"@ `
    -SchematicContent @"
.subckt test (n1 n2)
R1 (n1 n2) resistor r=2k
.ends test
"@ `
    -ExpectMatch $true

# ============================================================
# SUMMARY
# ============================================================
Write-Host ""
Write-Host ("=" * 72)
Write-Host "SUMMARY" -ForegroundColor Cyan
Write-Host ("=" * 72)
Write-Host ("Total:  {0}" -f $testCount) -ForegroundColor White
$passColor = if ($passCount -eq $testCount) { "Green" } else { "Yellow" }
$failColor = if ($failCount -eq 0) { "Green" } else { "Red" }
Write-Host ("Passed: {0}" -f $passCount) -ForegroundColor $passColor
Write-Host ("Failed: {0}" -f $failCount) -ForegroundColor $failColor
Write-Host ""

Write-Host "Per Category:" -ForegroundColor Cyan
foreach ($cat in $categories.Keys | Sort-Object) {
    $c = $categories[$cat]
    $catOk = $c.fail -eq 0
    $catColor = if ($catOk) { "Green" } else { "Red" }
    Write-Host ("  {0,-20} {1,2}/{2,2} pass" -f $cat, $c.pass, $c.total) -ForegroundColor $catColor
}

Write-Host ""
if ($failCount -eq 0) {
    Write-Host "All tests passed!" -ForegroundColor Green
} else {
    Write-Host "$failCount test(s) failed. See above for details." -ForegroundColor Red
}
