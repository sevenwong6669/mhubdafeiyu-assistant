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
    Assert-LocalTextSnapshot $Change.path $Change.written
    if ($Change.expected.existed) {
        Copy-Item -LiteralPath $Change.recoveryCopy -Destination $Change.path -Force
        if ($Change.recoveryCopy -ne $Change.backup) { [IO.File]::Delete($Change.recoveryCopy) }
    } else {
        [IO.File]::Delete($Change.path)
    }
}
