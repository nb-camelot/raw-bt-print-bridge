param(
  [string]$Port = 'COM9',
  [string]$Code = 'DEMO-0001',
  [string]$Url = '',
  [int]$MaxWidth = 384,
  [int]$Threshold = 140
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$logoPath = Join-Path $PSScriptRoot 'assets\logo.png'
$src = [System.Drawing.Bitmap]::FromFile($logoPath)

$tw = $MaxWidth - ($MaxWidth % 8)
$th = [int][Math]::Round($src.Height * ($tw / $src.Width))

$bmp = New-Object System.Drawing.Bitmap($tw, $th)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src, 0, 0, $tw, $th)
$g.Dispose()

$bytesPerRow = [int]($tw / 8)
$raster = New-Object System.Collections.Generic.List[byte]
for ($y = 0; $y -lt $th; $y++) {
  for ($b = 0; $b -lt $bytesPerRow; $b++) {
    $val = 0
    for ($bit = 0; $bit -lt 8; $bit++) {
      $c = $bmp.GetPixel($b * 8 + $bit, $y)
      $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
      if ($lum -lt $Threshold) { $val = $val -bor (1 -shl (7 - $bit)) }
    }
    $raster.Add([byte]$val)
  }
}

$preview = New-Object System.Drawing.Bitmap($tw, $th)
for ($y = 0; $y -lt $th; $y++) {
  for ($x = 0; $x -lt $tw; $x++) {
    $byte = $raster[$y * $bytesPerRow + [int]($x / 8)]
    $on = ($byte -band (1 -shl (7 - ($x % 8)))) -ne 0
    $preview.SetPixel($x, $y, $(if ($on) { [System.Drawing.Color]::Black } else { [System.Drawing.Color]::White }))
  }
}
$preview.Save((Join-Path $PSScriptRoot 'assets\logo_preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()

$ms = New-Object System.IO.MemoryStream
function W([byte[]]$b) { $ms.Write($b, 0, $b.Length) }
function T([string]$s) { W ([System.Text.Encoding]::ASCII.GetBytes($s)) }
function NL { W (, 10) }

W (0x1B, 0x40)
W (0x1B, 0x74, 0x10)
W (0x1B, 0x61, 0x01)

$xL = $bytesPerRow -band 0xFF
$xH = ($bytesPerRow -shr 8) -band 0xFF
$yL = $th -band 0xFF
$yH = ($th -shr 8) -band 0xFF
W (0x1D, 0x76, 0x30, 0x00, $xL, $xH, $yL, $yH)
$raster.ToArray() | ForEach-Object { W (,$_) }

NL
W (0x1B, 0x21, 0x00)
W (0x1B, 0x45, 0x01)
T "RICEVUTA DI PROVA"; NL
W (0x1B, 0x45, 0x00)
W (0x1B, 0x61, 0x00)
T ("-" * 32); NL
T "Codice:"; NL
W (0x1B, 0x21, 0x18)
T $Code; NL
W (0x1B, 0x21, 0x00)
T ("-" * 32); NL
W (0x1B, 0x61, 0x01)
$url = if ($Url) { $Url } else { "https://example.com/r/$Code" }
$data = [System.Text.Encoding]::ASCII.GetBytes($url)
$len = $data.Length + 3
$pL = $len -band 0xFF; $pH = ($len -shr 8) -band 0xFF
W (0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00)
W (0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x06)
W (0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x31)
W (0x1D, 0x28, 0x6B, $pL, $pH, 0x31, 0x50, 0x30)
W $data
W (0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30)
NL
W (0x1B, 0x61, 0x01)
T $url; NL
W (0x1B, 0x64, 0x03)
W (0x1D, 0x56, 0x00)

$bytes = $ms.ToArray()
$ms.Dispose()

$sp = New-Object System.IO.Ports.SerialPort $Port
$sp.BaudRate = 9600; $sp.Handshake = 'None'; $sp.DtrEnable = $true; $sp.RtsEnable = $true
$sp.Open()
$sp.Write($bytes, 0, $bytes.Length)
Start-Sleep -Milliseconds 1200
$sp.Close()

"Logo raster: ${tw}x${th} dot ($bytesPerRow byte/riga)  soglia=$Threshold"
"Totale inviato: $($bytes.Length) byte su $Port"
"Codice: $Code  ->  $url"
[Convert]::ToBase64String($bytes) | Out-File (Join-Path $PSScriptRoot 'assets\last-payload.b64') -Encoding ASCII
"Payload base64 salvato in assets\last-payload.b64"
