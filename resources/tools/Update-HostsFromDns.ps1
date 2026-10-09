<#
.SYNOPSIS
    Resolves the OctoWoW realm hostnames against a specific DNS server and pins the results
    into the Windows hosts file. Run it and you are done - it elevates itself if needed.

.DESCRIPTION
    Queries the DNS server you specify, bypassing the local resolver's normal server list, the
    DNS cache, and the hosts file itself, then writes the answers into a clearly marked block in
    the hosts file. Re-running replaces that block in place, so entries never accumulate.
    Everything outside the markers is left untouched.

    Out of the box it:
      * re-launches itself elevated (UAC prompt) when the hosts file needs Administrator rights
      * comments out stale entries for the same names elsewhere in the file, which would
        otherwise take precedence over the block it writes
      * probes each resolved address on the game port and drops any that don't answer, so a
        round-robin name with a dead address mixed in doesn't hand the client a coin flip
      * writes every remaining address a name resolves to, sorted, so repeated runs are stable
      * backs the hosts file up first and flushes the DNS cache afterwards
      * keeps the window open at the end so you can read the result

.PARAMETER Server
    IP address (or hostname) of the DNS server to query. Defaults to 37.156.68.20.

.PARAMETER Name
    One or more hostnames to look up. Defaults to normal.octowow.st and play.octowow.st.

.PARAMETER HostsPath
    Path to the hosts file. Defaults to %SystemRoot%\System32\drivers\etc\hosts.

.PARAMETER Tag
    Label used in the BEGIN/END marker comments. Use different tags to maintain several
    independent blocks in the same file.

.PARAMETER FirstOnly
    Write only the first address per name instead of every A record returned.

.PARAMETER SkipVerify
    Write every resolved address without probing it first. By default each address is tried
    on -VerifyPort before being written; one that never answers is dropped from the block
    (unless dropping it would leave a name with none, in which case everything resolved for
    that name is written anyway, since a probe failing everywhere more likely means this
    network can't run the probe than that every address is really dead).

.PARAMETER VerifyPort
    TCP port used to probe each resolved address. Defaults to 3724, the realm login port -
    the one every entry in the block actually needs to reach.

.PARAMETER VerifyTimeoutMs
    Milliseconds to wait for each probe to connect. Defaults to 2000.

.PARAMETER VerifyAttempts
    Probes per address before calling it dead, spaced a couple of seconds apart. Defaults to
    3. A single failed probe is too easy to catch mid-hiccup; several in a row spaced out is
    what actually distinguishes a dead address from a slow one.

.PARAMETER KeepConflicting
    Leave pre-existing entries for the same names alone. By default they are commented out,
    because Windows uses the first match in the file and such a line would override this
    block. Lines that also map other hostnames are never touched, only reported.

.PARAMETER NoBackup
    Skip writing a timestamped backup of the hosts file before changing it.

.PARAMETER NoFlush
    Skip running "ipconfig /flushdns" after a successful update.

.PARAMETER NoElevate
    Fail with a message instead of prompting for elevation.

.PARAMETER Pause
    Wait for Enter before exiting. Implied when the script has re-launched itself elevated.

.PARAMETER CreateShortcut
    Create a Desktop shortcut pointing at this script's current location, with the execution
    policy bypassed and the "Run as administrator" flag set, then exit. Run this again after
    moving the folder - a .lnk records an absolute path and cannot follow the script.

.PARAMETER Elevated
    Internal. Set automatically on the elevated re-launch; also suppresses a second attempt.

.EXAMPLE
    .\Update-HostsFromDns.ps1
    Does the whole job: prompts for elevation, resolves both names, updates the hosts file.

.EXAMPLE
    .\Update-HostsFromDns.ps1 -WhatIf
    Shows what would be written without touching anything. Needs no elevation.

.EXAMPLE
    .\Update-HostsFromDns.ps1 -Server 10.0.0.53 -Name intranet.corp.local -Tag CorpVPN
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Server = '37.156.68.20',

    [Parameter(Position = 1)]
    [ValidateNotNullOrEmpty()]
    [string[]]$Name = @('normal.octowow.st', 'play.octowow.st'),

    [string]$HostsPath = (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'),

    [ValidatePattern('^[A-Za-z0-9 ._-]+$')]
    [string]$Tag = 'OctoWoW',

    [switch]$FirstOnly,

    [switch]$SkipVerify,

    [ValidateRange(1, 65535)]
    [int]$VerifyPort = 3724,

    [ValidateRange(100, 60000)]
    [int]$VerifyTimeoutMs = 2000,

    [ValidateRange(1, 10)]
    [int]$VerifyAttempts = 3,

    [switch]$KeepConflicting,

    [switch]$NoBackup,

    [switch]$NoFlush,

    [switch]$NoElevate,

    [switch]$Pause,

    [switch]$CreateShortcut,

    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

$ipv4Pattern = '^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$'

function Test-IsAdministrator {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-NameAgainstServer {
    param(
        [string]$HostName,
        [string]$DnsServer,
        [string]$Pattern
    )

    $result = @()

    if (Get-Command -Name Resolve-DnsName -ErrorAction SilentlyContinue) {
        try {
            # -DnsOnly skips LLMNR/NetBIOS; -NoHostsFile stops it answering from the file we are about to edit.
            $answers = Resolve-DnsName -Name $HostName -Type A -Server $DnsServer -DnsOnly -NoHostsFile -ErrorAction Stop
            foreach ($a in $answers) {
                if ($a.PSObject.Properties['IPAddress'] -and $a.IPAddress -match $Pattern) {
                    $result += $a.IPAddress
                }
            }
        }
        catch {
            Write-Warning ("Lookup of '{0}' on {1} failed: {2}" -f $HostName, $DnsServer, $_.Exception.Message)
            return @()
        }
    }
    else {
        # Fallback for hosts without the DnsClient module (Windows 7). nslookup prints
        # "Non-authoritative answer:" on stderr, and Windows PowerShell turns that into a
        # terminating error under the script's 'Stop' preference - so relax it here.
        $ErrorActionPreference = 'Continue'
        $raw = & nslookup.exe "-type=A" $HostName $DnsServer 2>$null
        $lines = @($raw) -split "`r?`n"
        $start = -1
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^\s*Name:') { $start = $i; break }
        }
        if ($start -lt 0) {
            Write-Warning ("Lookup of '{0}' on {1} returned no answer." -f $HostName, $DnsServer)
            return @()
        }
        for ($i = $start; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^\s*Address(?:es)?:\s*(.+)$') {
                $result += ($matches[1] -split '[,\s]+')
            }
            elseif ($lines[$i] -match '^\s{2,}(\S+)\s*$') {
                $result += $matches[1]
            }
        }
        $result = @($result | Where-Object { $_ -match $Pattern })
    }

    # Sorted so that a round-robin name does not reshuffle the file on every run.
    return @($result | Select-Object -Unique | Sort-Object { [version]$_ })
}

function Test-AddressReachable {
    param(
        [string]$IPAddress,
        [int]$Port,
        [int]$TimeoutMs,
        [int]$Attempts
    )

    # A dropped/scrubbed address times out rather than refusing, and can briefly recover, so a
    # single failed probe does not prove it is dead. Any one success is enough to call it
    # reachable - the failure mode worth protecting against is wrongly dropping a good address,
    # not wrongly keeping a bad one, since a bad one left in just costs a retry like it does
    # today. Only an address that fails every attempt, spaced out, gets dropped.
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $client = New-Object System.Net.Sockets.TcpClient
        $ok = $false
        try {
            # BeginConnect, not ConnectAsync: Windows 7's PowerShell 2.0 runs on .NET 2/3.5,
            # which has no ConnectAsync - every probe would fail and drop good addresses.
            $pending = $client.BeginConnect($IPAddress, $Port, $null, $null)
            if ($pending.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
                $client.EndConnect($pending)
                $ok = $client.Connected
            }
        }
        catch {
            $ok = $false
        }
        finally {
            $client.Close()
        }
        if ($ok) { return $true }
        if ($attempt -lt $Attempts) { Start-Sleep -Seconds 2 }
    }
    return $false
}

function Invoke-SelfElevation {
    param(
        $BoundParameters,
        [string]$ScriptPath
    )

    if (-not $ScriptPath) { throw 'Cannot determine this script''s own path in order to re-launch it elevated.' }

    # Rebuild this invocation as an encoded command - sidesteps every quoting problem with
    # paths that contain spaces or parentheses.
    $inner = "& '" + ($ScriptPath -replace "'", "''") + "'"
    foreach ($kv in $BoundParameters.GetEnumerator()) {
        $key = $kv.Key
        $val = $kv.Value
        if ($val -is [System.Management.Automation.SwitchParameter]) {
            if ($val.IsPresent) { $inner += " -$key" }
        }
        elseif ($val -is [array]) {
            $items = @($val | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ','
            $inner += " -$key $items"
        }
        else {
            $inner += " -$key '" + ([string]$val -replace "'", "''") + "'"
        }
    }
    $inner += ' -Elevated'

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))
    $psExe = (Get-Process -Id $PID).Path
    if (-not $psExe) { $psExe = 'powershell.exe' }

    Write-Host 'Administrator rights are needed to edit the hosts file - approve the prompt.' -ForegroundColor Yellow
    try {
        Start-Process -FilePath $psExe -Verb RunAs `
                      -ArgumentList "-NoProfile -ExecutionPolicy Bypass -EncodedCommand $encoded" | Out-Null
    }
    catch {
        throw "Elevation was cancelled or failed. Right-click PowerShell, choose 'Run as administrator', and run this script again."
    }
    Write-Host 'Continuing in the elevated window.' -ForegroundColor Cyan
}

function New-LauncherShortcut {
    param([string]$ScriptPath)

    # A .lnk stores an absolute path, so it can only be generated once the script is sitting in
    # its final location - which is why this is a switch rather than a file shipped in the zip.
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Update OctoWoW Hosts.lnk'
    $psExe = (Get-Process -Id $PID).Path
    if (-not $psExe -or $psExe -notmatch '(?i)powershell|pwsh') {
        $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    }

    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath       = $psExe
    $sc.Arguments        = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -Pause' -f $ScriptPath
    $sc.WorkingDirectory = Split-Path -Parent $ScriptPath
    $sc.Description      = 'Resolve the realm hostnames and pin them in the Windows hosts file'
    $sc.WindowStyle      = 1
    $netshell = Join-Path $env:SystemRoot 'System32\netshell.dll'
    if (Test-Path -LiteralPath $netshell) { $sc.IconLocation = "$netshell,0" }
    $sc.Save()
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($sc)
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

    # Set the "Run as administrator" flag - bit 0x20 of the link flags at offset 0x15. The COM
    # shortcut API exposes no property for it, and without it you get two windows instead of one.
    try {
        $bytes = [System.IO.File]::ReadAllBytes($lnk)
        $bytes[0x15] = $bytes[0x15] -bor 0x20
        [System.IO.File]::WriteAllBytes($lnk, $bytes)
    }
    catch {
        Write-Warning "Shortcut created, but the 'Run as administrator' flag could not be set: $($_.Exception.Message)"
    }

    Write-Host ''
    Write-Host ('Desktop shortcut created: {0}' -f $lnk) -ForegroundColor Green
    Write-Host ('  -> {0}' -f $ScriptPath) -ForegroundColor DarkGray
    Write-Host '  Re-run with -CreateShortcut if you ever move this folder.' -ForegroundColor DarkGray
}

$exitCode = 0
$handedOff = $false

try {
    $selfPath = $PSCommandPath
    if (-not $selfPath) { $selfPath = $MyInvocation.MyCommand.Path }

    if ($CreateShortcut) {
        New-LauncherShortcut -ScriptPath $selfPath
        return
    }

    Write-Host ''
    Write-Host '  Update-HostsFromDns' -ForegroundColor Cyan
    Write-Host ('  DNS server : {0}' -f $Server)
    Write-Host ('  Hostnames  : {0}' -f ($Name -join ', '))
    Write-Host ''

    # --- Sanity checks ----------------------------------------------------------------------

    $systemRoot = [System.IO.Path]::GetFullPath($env:SystemRoot)
    $targetFull = [System.IO.Path]::GetFullPath($HostsPath)
    $isSystemFile = $targetFull.StartsWith($systemRoot, [StringComparison]::OrdinalIgnoreCase)
    $needsAdmin = $isSystemFile -and -not $WhatIfPreference

    if ($needsAdmin -and -not (Test-IsAdministrator)) {
        if ($NoElevate -or $Elevated) {
            throw "Editing '$targetFull' requires elevation. Run this script from an Administrator PowerShell session (or add -WhatIf to preview without writing)."
        }
        Invoke-SelfElevation -BoundParameters $PSBoundParameters -ScriptPath $selfPath
        # The elevated child does the pausing; this window must not sit waiting for Enter too.
        $handedOff = $true
        return
    }

    if (-not (Test-Path -LiteralPath $targetFull)) {
        throw "Hosts file not found at '$targetFull'."
    }

    $beginMarker = "# BEGIN $Tag"
    $endMarker   = "# END $Tag"

    # --- Read the current file and locate our block -------------------------------------------

    $existing = @(Get-Content -LiteralPath $targetFull)

    $beginIdx = -1
    $endIdx   = -1
    for ($i = 0; $i -lt $existing.Count; $i++) {
        $trimmed = $existing[$i].Trim()
        if ($beginIdx -lt 0 -and $trimmed -eq $beginMarker) { $beginIdx = $i }
        elseif ($beginIdx -ge 0 -and $endIdx -lt 0 -and $trimmed -eq $endMarker) { $endIdx = $i }
    }
    $hasBlock = ($beginIdx -ge 0 -and $endIdx -gt $beginIdx)

    if ($beginIdx -ge 0 -and -not $hasBlock) {
        throw "Found '$beginMarker' in '$targetFull' but no matching '$endMarker'. Fix the file by hand before re-running."
    }

    # Remember what the block held, so a failed lookup can fall back to the last known good address.
    $previous = @{}
    if ($hasBlock) {
        foreach ($line in $existing[($beginIdx + 1)..($endIdx - 1)]) {
            if ($line -match '^\s*(\S+)\s+(\S+)') {
                $prevIp = $matches[1]
                $prevHost = $matches[2]
                if ($prevIp -match $ipv4Pattern) {
                    if (-not $previous.ContainsKey($prevHost)) { $previous[$prevHost] = @() }
                    $previous[$prevHost] = @($previous[$prevHost]) + $prevIp
                }
            }
        }
    }

    # Entries for the same names outside our block take precedence - the first match in the file
    # wins, so a stale manual line above the block silently defeats everything written below it.
    $conflictCount = 0
    $blockedCount  = 0
    for ($i = 0; $i -lt $existing.Count; $i++) {
        if ($hasBlock -and $i -ge $beginIdx -and $i -le $endIdx) { continue }
        $line = $existing[$i]
        if ($line -match '^\s*(?:#|$)') { continue }
        if ($line -match '^\s*(\S+)\s+(.+)$') {
            $lineHosts = @()
            foreach ($tok in ($matches[2] -split '\s+')) {
                if ($tok -match '^#') { break }
                if ($tok) { $lineHosts += $tok }
            }
            $clashing = @($lineHosts | Where-Object { $Name -contains $_ })
            if ($clashing.Count -eq 0) { continue }

            $conflictCount++
            if (-not $KeepConflicting -and $clashing.Count -eq $lineHosts.Count) {
                $verb = 'Commenting out'
                if ($WhatIfPreference) { $verb = 'Would comment out' }
                $existing[$i] = "# {0}   # disabled by Update-HostsFromDns.ps1 {1}" -f $line.Trim(), (Get-Date -Format 'yyyy-MM-dd')
                Write-Host ("  {0} stale line {1}: {2}" -f $verb, ($i + 1), $line.Trim()) -ForegroundColor Yellow
            }
            else {
                $blockedCount++
                Write-Warning ("Line {0} maps {1} outside the managed block and overrides it: {2}" -f ($i + 1), ($clashing -join ', '), $line.Trim())
                if (-not $KeepConflicting) {
                    $others = @($lineHosts | Where-Object { $Name -notcontains $_ })
                    Write-Warning ("  Left in place because the same line also maps: {0}. Remove it by hand if the realm stays unreachable." -f ($others -join ', '))
                }
            }
        }
    }
    if ($conflictCount -gt 0 -and $KeepConflicting) {
        Write-Warning 'Those lines override the block below. Drop -KeepConflicting to have them commented out.'
    }

    # --- Resolve --------------------------------------------------------------------------------

    $entries    = New-Object System.Collections.ArrayList
    $resolved   = 0
    $reused     = 0
    $failed     = 0
    $droppedDead = 0

    if (-not $SkipVerify) {
        Write-Host ("  Probing each address on port {0} ({1} attempt(s) each)..." -f $VerifyPort, $VerifyAttempts) -ForegroundColor DarkGray
    }

    foreach ($hostName in ($Name | Select-Object -Unique)) {
        $addresses = @(Resolve-NameAgainstServer -HostName $hostName -DnsServer $Server -Pattern $ipv4Pattern)

        if ($addresses.Count -eq 0) {
            if ($previous.ContainsKey($hostName)) {
                $addresses = @($previous[$hostName])
                $reused++
                Write-Warning ("Keeping previous address(es) for '{0}': {1}" -f $hostName, ($addresses -join ', '))
            }
            else {
                $failed++
                Write-Warning ("No address for '{0}' and nothing previously recorded - skipping." -f $hostName)
                continue
            }
        }
        else {
            $resolved++
        }

        if (-not $SkipVerify -and $addresses.Count -gt 0) {
            $alive = New-Object System.Collections.ArrayList
            $dead  = New-Object System.Collections.ArrayList
            foreach ($ip in $addresses) {
                if (Test-AddressReachable -IPAddress $ip -Port $VerifyPort -TimeoutMs $VerifyTimeoutMs -Attempts $VerifyAttempts) {
                    [void]$alive.Add($ip)
                    Write-Host ("    {0,-16} {1,-20} reachable" -f $ip, $hostName) -ForegroundColor Green
                }
                else {
                    [void]$dead.Add($ip)
                    Write-Host ("    {0,-16} {1,-20} not answering - dropping" -f $ip, $hostName) -ForegroundColor Yellow
                }
            }
            if ($alive.Count -gt 0) {
                $droppedDead += $dead.Count
                $addresses = @($alive)
            }
            elseif ($dead.Count -gt 0) {
                # Every address for this name failed the probe. More likely this network can't
                # make the probe (a local firewall, or the probe itself being blocked) than that
                # a whole round-robin name is really down - so fall back to writing them all
                # rather than leaving the name with nothing.
                Write-Warning ("None of {0}'s addresses answered on port {1} - writing all of them unverified rather than leaving it with none." -f $hostName, $VerifyPort)
            }
        }

        if ($FirstOnly) { $addresses = @($addresses[0]) }

        foreach ($ip in $addresses) {
            [void]$entries.Add((New-Object PSObject -Property @{ IPAddress = $ip; HostName = $hostName }))
        }
    }

    if ($entries.Count -eq 0) {
        Write-Warning 'Nothing resolved. Hosts file left unchanged.'
        Write-Host ''
        Write-Host ("Check that {0} is reachable and that you are online." -f $Server) -ForegroundColor Yellow
        $exitCode = 1
        return
    }

    # --- Build the replacement block ----------------------------------------------------------

    $block = New-Object System.Collections.ArrayList
    [void]$block.Add($beginMarker)
    [void]$block.Add(("# Written {0} from DNS server {1} by Update-HostsFromDns.ps1" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Server))
    [void]$block.Add('# Regenerated on each run - re-run the script instead of editing this block.')
    if ($droppedDead -gt 0) {
        [void]$block.Add(("# {0} resolved address(es) did not answer on port {1} and were left out." -f $droppedDead, $VerifyPort))
    }
    foreach ($e in $entries) {
        [void]$block.Add(('{0,-16} {1}' -f $e.IPAddress, $e.HostName))
    }
    [void]$block.Add($endMarker)

    if ($hasBlock) {
        $head = @()
        if ($beginIdx -gt 0) { $head = $existing[0..($beginIdx - 1)] }
        $tail = @()
        if ($endIdx -lt ($existing.Count - 1)) { $tail = $existing[($endIdx + 1)..($existing.Count - 1)] }
        $newLines = @($head) + @($block) + @($tail)
    }
    else {
        $newLines = @($existing)
        if ($newLines.Count -gt 0 -and $newLines[-1].Trim() -ne '') { $newLines += '' }
        $newLines = @($newLines) + @($block)
    }

    $newContent = ($newLines -join "`r`n") + "`r`n"

    # --- Write -----------------------------------------------------------------------------------

    $description = "Write {0} entry/entries into the '{1}' block" -f $entries.Count, $Tag
    if (-not $PSCmdlet.ShouldProcess($targetFull, $description)) {
        Write-Host ''
        Write-Host 'Would write:' -ForegroundColor Cyan
        $block | ForEach-Object { Write-Host "  $_" }
        return
    }

    if (-not $NoBackup) {
        $backup = '{0}.bak-{1}' -f $targetFull, (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $targetFull -Destination $backup -Force
        Write-Host ("  Backup: {0}" -f $backup) -ForegroundColor DarkGray
    }

    try {
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($targetFull, $newContent, $utf8NoBom)
    }
    catch [System.UnauthorizedAccessException] {
        throw "Access denied writing '$targetFull'. Check that antivirus tamper protection is not locking the hosts file."
    }

    Write-Host ''
    $entries | Format-Table -AutoSize IPAddress, HostName | Out-Host
    Write-Host ('Updated {0}' -f $targetFull) -ForegroundColor Green
    $verifyNote = ''
    if (-not $SkipVerify) { $verifyNote = ', {0} dropped as unreachable' -f $droppedDead }
    Write-Host ('  {0} resolved, {1} reused from the previous block, {2} failed{3}.' -f $resolved, $reused, $failed, $verifyNote)

    if (-not $NoFlush) {
        & ipconfig.exe /flushdns | Out-Null
        Write-Host '  DNS resolver cache flushed.'
    }

    Write-Host ''
    if ($blockedCount -gt 0) {
        Write-Host 'One or more shared hosts-file lines still override these entries - see the warnings above.' -ForegroundColor Yellow
    }
    else {
        Write-Host 'All set. Restart the game client if it is already running.' -ForegroundColor Green
    }
}
catch {
    Write-Host ''
    Write-Host ('ERROR: {0}' -f $_.Exception.Message) -ForegroundColor Red
    $exitCode = 1
}
finally {
    if (-not $handedOff -and ($Elevated -or $Pause)) {
        Write-Host ''
        Read-Host 'Press Enter to close this window' | Out-Null
    }
}

exit $exitCode
