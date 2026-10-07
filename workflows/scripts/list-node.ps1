# Identify running node.exe processes by command line (read-only)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    ForEach-Object { "PID " + $_.ProcessId + ": " + $_.CommandLine }
