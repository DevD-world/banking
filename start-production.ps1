$ErrorActionPreference = "Stop"
$env:HOST = if ($env:HOST) { $env:HOST } else { "0.0.0.0" }
$env:PORT = if ($env:PORT) { $env:PORT } else { "8000" }
$env:COMPLETION_IQ_DATA_DIR = if ($env:COMPLETION_IQ_DATA_DIR) { $env:COMPLETION_IQ_DATA_DIR } else { "$PSScriptRoot\backend" }
python "$PSScriptRoot\backend\server.py"
