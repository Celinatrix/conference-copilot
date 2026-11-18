# Long-running Windows speech worker for the server (spawned by windows.ts; not meant to be run by hand).
# Protocol, one line each way, all payloads base64 so no console code page can mangle Vietnamese:
#   start-up  -> "READY <base64 voice name>"  or  "NOVOICE <base64 list of installed voices>"
#   stdin     <- "<id> <base64 UTF-8 text>"
#   stdout    -> "<id> OK <base64 WAV bytes>"  or  "<id> ERR <base64 message>"
param([string]$Lang = 'vi', [double]$Rate = 1.0)

$ErrorActionPreference = 'Stop'
$b64 = { param([string]$s) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)) }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Wait-WinRt($operation, [Type]$resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
  [void]$task.Wait(-1)
  $task.Result
}

$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$voice = $all | Where-Object { $_.Language -like "$Lang*" } | Select-Object -First 1
if (-not $voice) {
  [Console]::Out.WriteLine('NOVOICE ' + (& $b64 (($all | ForEach-Object { "$($_.DisplayName) ($($_.Language))" }) -join ', ')))
  exit 0
}

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$synth.Voice = $voice
try { $synth.Options.SpeakingRate = [Math]::Min(3.0, [Math]::Max(0.5, $Rate)) } catch { }
[Console]::Out.WriteLine('READY ' + (& $b64 $voice.DisplayName))

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ', 2)
  if ($parts.Count -ne 2) { continue }
  $id = $parts[0]
  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
    $stream = Wait-WinRt ($synth.SynthesizeTextToStreamAsync($text)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
    $size = [uint32]$stream.Size
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    [void](Wait-WinRt ($reader.LoadAsync($size)) ([uint32]))
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    $reader.Dispose()
    $stream.Dispose()
    [Console]::Out.WriteLine("$id OK " + [Convert]::ToBase64String($bytes))
  } catch {
    [Console]::Out.WriteLine("$id ERR " + (& $b64 $_.Exception.Message))
  }
}
