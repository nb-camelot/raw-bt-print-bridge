param(
  [int]$Port = 8000,
  [string]$Root = $PSScriptRoot
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

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
$listener.Start()
Write-Host "Server attivo sulla porta $Port (root: $Root)"

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 3000
      $stream = $client.GetStream()
      $stream.ReadTimeout = 3000
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII)

      $requestLine = $null
      try { $requestLine = $reader.ReadLine() } catch { }
      try { while (($line = $reader.ReadLine()) -ne '' -and $null -ne $line) { } } catch { }

      if ([string]::IsNullOrEmpty($requestLine)) { $client.Close(); continue }

      $path = '/'
      if ($requestLine -match '^GET\s+(\S+)') { $path = $matches[1] }
      $path = ($path -split '\?')[0]
      if ($path -eq '/') { $path = '/print-test.html' }
      $path = [System.Uri]::UnescapeDataString($path).TrimStart('/')
      $full = Join-Path $Root $path

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

      $header = "HTTP/1.1 $status`r`nContent-Type: $ctype`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
      $hb = [System.Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($hb, 0, $hb.Length)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush()
      Write-Host "$(Get-Date -Format 'HH:mm:ss')  $status  /$path  ($($bytes.Length) byte)"
    } catch {
      Write-Host "Errore richiesta: $($_.Exception.Message)"
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
