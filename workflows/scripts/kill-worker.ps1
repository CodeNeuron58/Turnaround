# Kill every running Turnaround worker (node processes running worker.ts).
# TaskStop on Windows doesn't reliably kill npm's child processes — this does.
$procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
$workers = $procs | Where-Object { $_.CommandLine -match 'worker\.ts' }
foreach ($w in $workers) {
    Write-Output ("killing worker PID " + $w.ProcessId)
    Stop-Process -Id $w.ProcessId -Force
}
if ($workers) { Start-Sleep -Seconds 1 }
$left = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'worker\.ts' }
if ($left) {
    Write-Output "still alive:"
    $left | ForEach-Object { Write-Output ("  PID " + $_.ProcessId) }
} else {
    Write-Output "all worker.ts processes gone"
}
