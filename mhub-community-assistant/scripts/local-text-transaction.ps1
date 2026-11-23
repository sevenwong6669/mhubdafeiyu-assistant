function Get-LocalTextDigest([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($sha.ComputeHash($Bytes)) }
    finally { $sha.Dispose() }
}

function Read-LocalTextSnapshot([string]$Path) {
    try { $bytes = [IO.File]::ReadAllBytes($Path) }
    catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] {
        return @{existed = $false; text = ''; digest = $null}
    }
    $stream = [IO.MemoryStream]::new($bytes, $false)
    $reader = [IO.StreamReader]::new($stream)
    try {
        return @{existed = $true; text = $reader.ReadToEnd(); digest = (Get-LocalTextDigest $bytes)}
    } finally { $reader.Dispose() }
}

function Assert-LocalTextSnapshot([string]$Path, $Expected, [string]$Target = $Path) {
    $observed = Read-LocalTextSnapshot $Path
    if ($observed.existed -ne $Expected.existed -or $observed.digest -cne $Expected.digest) {
        throw "Configuration changed during the operation: $Target. Review the latest file and retry."
    }
}

function Write-CheckedText($Change) {
    $path = $Change.path
    $temporary = "$path.change-$([guid]::NewGuid().ToString('N')).tmp"
    $previous = "$temporary.previous"
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Change.content)
    $digest = Get-LocalTextDigest $bytes
    try {
        [IO.File]::WriteAllBytes($temporary, $bytes)
        Assert-LocalTextSnapshot $path $Change.expected
        if ($Change.expected.existed) {
            # Keep the atomic replacement on the destination volume. The
            # installation backup directory can be on a different drive.
            [IO.File]::Replace($temporary, $path, $previous)
            $Change.recoveryCopy = $previous
        } else {
            [IO.File]::Move($temporary, $path)
        }
        $Change.written = @{existed = $true; digest = $digest}
        # Replace captures the actual previous bytes even if another writer
        # reached the file in the interval after the pre-commit check.
        if ($Change.expected.existed) {
            [IO.File]::Copy($previous, $Change.backup)
            $Change.recoveryCopy = $Change.backup
            [IO.File]::Delete($previous)
            Assert-LocalTextSnapshot $Change.backup $Change.expected $path
        }
    } finally { [IO.File]::Delete($temporary) }
}

function Undo-CheckedText($Change) {
    if (!$Change.written) { return }
    $path = $Change.path
    $temporary = "$path.rollback-$([guid]::NewGuid().ToString('N')).tmp"
    $displaced = "$temporary.conflict"
    try {
        $restored = $null
        if ($Change.expected.existed) {
            [IO.File]::Copy($Change.recoveryCopy, $temporary)
            $restored = Read-LocalTextSnapshot $temporary
        }
        Assert-LocalTextSnapshot $path $Change.written
        if ($restored) {
            [IO.File]::Replace($temporary, $path, $displaced)
        } else {
            [IO.File]::Move($path, $displaced)
        }
        $actual = Read-LocalTextSnapshot $displaced
        if ($actual.digest -cne $Change.written.digest) {
            Restore-RollbackConflict $path $displaced $restored
        }
        [IO.File]::Delete($displaced)
        if ($restored -and $Change.recoveryCopy -ne $Change.backup) { [IO.File]::Delete($Change.recoveryCopy) }
    } finally { [IO.File]::Delete($temporary) }
}

function Restore-RollbackConflict([string]$Path, [string]$Displaced, $Restored) {
    # Put the concurrent version back with a move that cannot overwrite a
    # newer save. If another save already replaced our rollback, keep both.
    $latest = "$Displaced.latest"
    $preserve = $Displaced
    try {
        if ($Restored) {
            [IO.File]::Move($Path, $latest)
            if ((Read-LocalTextSnapshot $latest).digest -cne $Restored.digest) { $preserve = $latest }
        }
        [IO.File]::Move($preserve, $Path)
        if ($Restored -and $preserve -eq $Displaced) { [IO.File]::Delete($latest) }
    } catch {
        $copies = @($Displaced, $latest) | Where-Object { [IO.File]::Exists($_) }
        throw "Rollback conflict at $Path. Review the active file and preserved copies: $($copies -join ', ')."
    }
    if ($preserve -eq $latest) {
        throw "Rollback conflict at $Path. The latest save is active and the earlier concurrent version was saved at $Displaced."
    }
    throw "Rollback conflict at $Path. The concurrent save was preserved."
}
