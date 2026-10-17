param(
  [int]$Port = 8000,
  [string]$Root = $PSScriptRoot,
  [string]$PrinterPort = 'COM9'
)

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
}

function Read-HeaderBlock($stream) {
  $sb = New-Object System.Text.StringBuilder
  $buf = New-Object byte[] 1
  while ($sb.Length -lt 16384) {
    $n = $stream.Read($buf, 0, 1)
    if ($n -le 0) { break }
    [void]$sb.Append([char]$buf[0])
    if ($sb.ToString().EndsWith("`r`n`r`n")) { break }
  }
  return $sb.ToString()
}

function Read-Exact($stream, [int]$len) {
  $buf = New-Object byte[] $len
  $read = 0
  while ($read -lt $len) {
    $n = $stream.Read($buf, $read, $len - $read)
    if ($n -le 0) { break }
    $read += $n
  }
  if ($read -eq 0) { return ,@() }
  $out = New-Object byte[] $read
  [Array]::Copy($buf, $out, $read)
  return ,$out
}

function Get-PrinterStatus([string]$port) {
  $r = [ordered]@{
    port      = $port
    bluetooth = $false
    present   = $false
    openable  = $false
    error     = $null
    checkedAt = (Get-Date).ToString('s')
  }
  try {
    $bt = Get-PnpDevice -Class Bluetooth -ErrorAction Stop | Where-Object { $_.Status -eq 'OK' }
    $r.bluetooth = (($bt | Measure-Object).Count -gt 0)
  } catch { }
  try {
    $names = [System.IO.Ports.SerialPort]::GetPortNames()
    $r.present = ($names -contains $port)
    if ($r.present) {
      $sp = New-Object System.IO.Ports.SerialPort($port, 9600, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
      $sp.WriteTimeout = 1500
      $sp.ReadTimeout = 1500
      $sp.DtrEnable = $true
      $sp.RtsEnable = $true
      $sp.Open()
      Start-Sleep -Milliseconds 80
      $sp.Close()
      $sp.Dispose()
      $r.openable = $true
    }
  } catch {
    $r.error = $_.Exception.Message
  }
  return $r
}

function Send-PrinterBytes([string]$port, [byte[]]$bytes) {
  $sp = New-Object System.IO.Ports.SerialPort($port, 9600, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $sp.WriteTimeout = 5000
  $sp.DtrEnable = $true
  $sp.RtsEnable = $true
  $sp.Open()
  try {
    $sp.Write($bytes, 0, $bytes.Length)
    $sp.BaseStream.Flush()
  } finally {
    $sp.Close()
    $sp.Dispose()
  }
}

function Send-Response($stream, [string]$status, [string]$ctype, [byte[]]$bytes) {
  $header = "HTTP/1.1 $status`r`nContent-Type: $ctype`r`nContent-Length: $($bytes.Length)`r`nAccess-Control-Allow-Origin: *`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($hb, 0, $hb.Length)
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.Flush()
}

function Send-Json($stream, [string]$status, $obj) {
  $json = ($obj | ConvertTo-Json -Compress -Depth 5)
  Send-Response $stream $status 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($json))
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
$listener.Start()
Write-Host "Server attivo su :$Port (root: $Root, stampante: $PrinterPort)"
Write-Host "  pagina di test: http://localhost:$Port/"
Write-Host "  stato stampante: http://localhost:$Port/api/printer"

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 3000
      $stream = $client.GetStream()
      $stream.ReadTimeout = 3000
      $stream.WriteTimeout = 5000

      $head = Read-HeaderBlock $stream
      if ([string]::IsNullOrWhiteSpace($head)) { $client.Close(); continue }

      $lines = $head -split "`r`n"
      $requestLine = $lines[0]
      $method = 'GET'
      $path = '/'
      if ($requestLine -match '^([A-Z]+)\s+(\S+)') { $method = $matches[1]; $path = $matches[2] }
      $path = ($path -split '\?')[0]

      $contentLength = 0
      foreach ($l in $lines) {
        if ($l -match '^(?i)Content-Length:\s*(\d+)') { $contentLength = [int]$matches[1] }
      }
      $body = if ($contentLength -gt 0) { Read-Exact $stream $contentLength } else { @() }

      if ($path -eq '/api/printer') {
        Send-Json $stream '200 OK' (Get-PrinterStatus $PrinterPort)
        Write-Host "$(Get-Date -Format 'HH:mm:ss')  200  /api/printer"
        continue
      }

      if ($path -eq '/api/print') {
        if ($method -ne 'POST') {
          Send-Json $stream '405 Method Not Allowed' @{ ok = $false; error = 'usa POST' }
          continue
        }
        try {
          $text = [System.Text.Encoding]::ASCII.GetString($body).Trim()
          $payload = [Convert]::FromBase64String($text)
          Send-PrinterBytes $PrinterPort $payload
          Send-Json $stream '200 OK' @{ ok = $true; bytes = $payload.Length; port = $PrinterPort }
          Write-Host "$(Get-Date -Format 'HH:mm:ss')  200  /api/print ($($payload.Length) byte -> $PrinterPort)"
        } catch {
          Send-Json $stream '500 Internal Server Error' @{ ok = $false; error = $_.Exception.Message }
          Write-Host "$(Get-Date -Format 'HH:mm:ss')  500  /api/print -> $($_.Exception.Message)"
        }
        continue
      }

      if ($path -eq '/') { $path = '/index.html' }
      $rel = [System.Uri]::UnescapeDataString($path).TrimStart('/')
      $full = Join-Path $Root $rel

      $bytes = $null
      $ctype = 'application/octet-stream'
      $status = '200 OK'

      if ((Test-Path -LiteralPath $full -PathType Leaf) -and ([System.IO.Path]::GetFullPath($full)).StartsWith([System.IO.Path]::GetFullPath($Root))) {
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        if ($types.ContainsKey($ext)) { $ctype = $types[$ext] }
      } else {
        $status = '404 Not Found'
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('404')
        $ctype = 'text/plain; charset=utf-8'
      }

      Send-Response $stream $status $ctype $bytes
      Write-Host "$(Get-Date -Format 'HH:mm:ss')  $status  /$rel  ($($bytes.Length) byte)"
    } catch {
      Write-Host "Errore richiesta: $($_.Exception.Message)"
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
