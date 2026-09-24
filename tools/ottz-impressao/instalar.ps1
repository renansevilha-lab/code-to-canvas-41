# ============================================================================
# Instala o agente Ottz Impressao neste PC (rodar UMA vez, no PC da impressora).
#   Botao direito em instalar.ps1 -> "Executar com o PowerShell"
#   ou: powershell -ExecutionPolicy Bypass -File instalar.ps1
# Copia para C:\OttzImpressao e cria a tarefa "Ottz Impressao" que sobe o
# agente ao entrar no Windows (usuario atual, janela oculta) e reinicia se cair.
# Desinstalar: powershell -ExecutionPolicy Bypass -File instalar.ps1 -Remover
# ============================================================================
param([switch]$Remover)
$ErrorActionPreference = 'Stop'
$Destino = 'C:\OttzImpressao'
$Tarefa = 'Ottz Impressao'

if ($Remover) {
  Stop-ScheduledTask -TaskName $Tarefa -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Tarefa -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarefa removida. Pasta $Destino mantida (logs)."
  exit 0
}

New-Item -ItemType Directory -Force -Path $Destino | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'ottz-impressao.ps1') $Destino
Copy-Item -Force (Join-Path $PSScriptRoot 'config.json') $Destino

Write-Host 'Impressoras Zebra/ZPL que o agente enxerga neste PC:'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Destino 'ottz-impressao.ps1') -Listar

$acao = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Destino\ottz-impressao.ps1`"" `
  -WorkingDirectory $Destino
$gatilho = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $Tarefa -Action $acao -Trigger $gatilho -Settings $config `
  -Description 'Agente de impressao propria da Ottz (substitui o PrintNode)' -Force | Out-Null
Start-ScheduledTask -TaskName $Tarefa

Write-Host ''
Write-Host "Instalado em $Destino e rodando (tarefa '$Tarefa')."
Write-Host "Log: $Destino\logs\agente-AAAAMMDD.log"
Write-Host 'Para uma etiqueta de teste local: powershell -ExecutionPolicy Bypass -File C:\OttzImpressao\ottz-impressao.ps1 -Teste'
