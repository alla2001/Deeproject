# Replicates the stats process-tree walk so its result can be inspected outside
# the app. Pass the root pid to expand.
param([int]$Root)

$all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, WorkingSetSize, Name, CreationDate
$byPid = @{}
$children = @{}
foreach ($p in $all) {
  $byPid[[int]$p.ProcessId] = $p
  $parent = [int]$p.ParentProcessId
  if (-not $children.ContainsKey($parent)) { $children[$parent] = @() }
  $children[$parent] += [int]$p.ProcessId
}

function Ticks($p) { if ($null -eq $p.CreationDate) { 0 } else { $p.CreationDate.Ticks } }

foreach ($guard in @($false, $true)) {
  "=== creation-time guard: $guard ==="
  $seen = @{}
  $stack = New-Object System.Collections.Stack
  $stack.Push($Root)
  $total = 0
  $count = 0
  while ($stack.Count -gt 0) {
    $pid_ = $stack.Pop()
    if ($seen.ContainsKey($pid_)) { continue }
    $seen[$pid_] = $true
    $proc = $byPid[$pid_]
    if ($null -eq $proc) { continue }
    $total += $proc.WorkingSetSize
    $count++
    "  {0,-28} pid {1,-7} {2,7:N0} MB  {3}" -f $proc.Name, $pid_, ($proc.WorkingSetSize / 1MB), $proc.CreationDate
    foreach ($c in $children[$pid_]) {
      if ($seen.ContainsKey($c)) { continue }
      $child = $byPid[$c]
      if ($null -eq $child) { continue }
      if ($guard) {
        $ct = Ticks $child
        $pt = Ticks $proc
        if ($ct -gt 0 -and $pt -gt 0 -and $ct -lt $pt) {
          "      [rejected impostor] {0} pid {1} created {2} < parent {3}" -f $child.Name, $c, $child.CreationDate, $proc.CreationDate
          continue
        }
      }
      $stack.Push($c)
    }
  }
  "  TOTAL: {0} processes, {1:N0} MB" -f $count, ($total / 1MB)
}
