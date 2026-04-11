param([string]$OutFile)
$raw = Get-Clipboard -Raw
$b64 = $raw.Split(',')[1]
$bytes = [System.Convert]::FromBase64String($b64)
[System.IO.File]::WriteAllBytes($OutFile, $bytes)
Write-Host "Wrote $($bytes.Length) bytes to $OutFile"
