$ErrorActionPreference = "Stop"

$BackendRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $BackendRoot

if (-not (Test-Path ".env")) {
    throw "Missing irads-backend/.env configuration file."
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    throw "Python virtual environment not found. Create it and install consumer/requirements.txt first."
}

& ".\.venv\Scripts\python.exe" -m consumer.anomaly_consumer

if ($LASTEXITCODE -ne 0) {
    throw "IRADS Kafka consumer exited with code $LASTEXITCODE"
}
