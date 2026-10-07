# 无窗口执行一个命令，输出走日志文件。
#
# 为什么要这个：
# 直接 `& node.exe xxx.js` 会让控制台黑框弹出来（别人正用电脑时很干扰），
# Start-Process -WindowStyle Hidden 对控制台程序也只是尽量藏住，仍会闪一下。
# 这里用 ProcessStartInfo.CreateNoWindow 彻底不建窗口，输出改走重定向文件。
#
# 用法：
#   powershell -NoProfile -File scripts\run-hidden.ps1 -Exe "D:\GLB\node\node.exe" -CmdArgs "scripts\probe.mjs" -WorkDir "D:\GLB\Hermes"
#   powershell -NoProfile -File scripts\run-hidden.ps1 -Exe "npm.cmd" -CmdArgs "run typecheck"
#
# 两个踩过的坑，写在这里免得下次再犯：
#   1. 参数名不能叫 $Args —— 那是 PowerShell 自动变量，当参数名直接解析失败。
#   2. 本文件必须存成带 BOM 的 UTF-8。PowerShell 5.1 读无 BOM 的 .ps1 会按 ANSI 解码，
#      中文注释被打乱后会产生莫名其妙的语法错误。
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$CmdArgs = "",
  [string]$Log = "",
  [string]$WorkDir = ""
)

$ErrorActionPreference = 'Continue'

if (-not $Log) {
  $Log = Join-Path $env:TEMP ('runhidden-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.log')
}
$errLog = "$Log.err"
foreach ($f in @($Log, $errLog)) { if (Test-Path $f) { Remove-Item $f -Force } }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Exe
# 关键：不创建窗口。不加这句控制台程序一定会弹一个黑框出来
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
if ($CmdArgs) { $psi.Arguments = $CmdArgs }
if ($WorkDir) { $psi.WorkingDirectory = $WorkDir }

# 子进程按 UTF-8 写 stdout，.NET 默认按系统 ANSI 码页（本机是 GBK）读，
# 于是每个中文字符都变成乱码，脚本里的中文提示和断言信息全看不清。
# 不设这个，UTF8Encoding 探测也救不了 —— 必须显式指定。
try {
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding  = [System.Text.Encoding]::UTF8
} catch {
  Write-Warning '当前 .NET 不支持指定输出编码，中文日志可能是乱码'
}

$p = [System.Diagnostics.Process]::Start($psi)

# 必须异步读两个流：先同步读完 stdout 再读 stderr，
# 输出量大时 stderr 管道会写满，把子进程卡死在这里
$outTask = $p.StandardOutput.ReadToEndAsync()
$errTask = $p.StandardError.ReadToEndAsync()
$p.WaitForExit()

$out = $outTask.Result
$err = $errTask.Result
Set-Content -LiteralPath $Log -Value $out -Encoding UTF8
Set-Content -LiteralPath $errLog -Value $err -Encoding UTF8

Write-Output $out
if ($err) { Write-Output '---- stderr ----'; Write-Output $err }
Write-Output "---- exit=$($p.ExitCode) log=$Log ----"
exit $p.ExitCode