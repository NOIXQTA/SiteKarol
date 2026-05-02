$python = "C:\Users\saymo\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if (-not (Test-Path $python)) {
  $python = "python"
}

& $python "server.py"
