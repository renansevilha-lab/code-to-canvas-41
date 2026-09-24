# ============================================================================
# Ottz Impressao — agente de impressao propria (substituto do PrintNode)  v1.0.0
# ----------------------------------------------------------------------------
# Roda no PC da bancada. Pega os jobs da fila (funcao `impressao` no Supabase)
# e manda o ZPL CRU para a impressora pelo spooler do Windows (datatype RAW) —
# o mesmo caminho do PrintNode. So ZPL.
#
# Garantias (regra do dono: etiqueta impressa NUNCA sai de novo sozinha):
#  - impressora OFFLINE no Windows -> nao manda; job volta como ERRO (nao saiu).
#  - mandou e o spooler nao esvaziou em 60 s ou deu erro -> cancela o job no
#    Windows e reporta ERRO ("conferir na bancada").
#  - resultado que nao conseguiu avisar ao servidor fica salvo em disco e e
#    reenviado; o job fica 'pegou' (preso) no servidor ate la — nunca volta
#    para a fila sozinho.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File ottz-impressao.ps1           (roda o agente)
#   powershell -ExecutionPolicy Bypass -File ottz-impressao.ps1 -Teste    (etiqueta de teste local)
#   powershell -ExecutionPolicy Bypass -File ottz-impressao.ps1 -Listar   (impressoras que ele enxerga)
# ============================================================================
param(
  [string]$Config = (Join-Path $PSScriptRoot 'config.json'),
  [switch]$Teste,
  [switch]$Listar
)

$ErrorActionPreference = 'Stop'
$VERSAO = '1.0.0'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$cfg = Get-Content -Raw -Path $Config | ConvertFrom-Json
$Base = "$($cfg.url)/functions/v1/impressao"
$Hdr = @{ 'x-agente-token' = $cfg.token; 'apikey' = $cfg.apikey }
$Filtro = if ($cfg.filtro) { $cfg.filtro } else { 'ZDesigner|Zebra|ZPL' }
$DirLog = Join-Path $PSScriptRoot 'logs'
$ArqPendentes = Join-Path $PSScriptRoot 'resultados-pendentes.json'
New-Item -ItemType Directory -Force -Path $DirLog | Out-Null

function Log([string]$msg) {
  $linha = '{0:yyyy-MM-dd HH:mm:ss}  {1}' -f (Get-Date), $msg
  Add-Content -Path (Join-Path $DirLog ('agente-{0:yyyyMMdd}.log' -f (Get-Date))) -Value $linha -Encoding UTF8
  Write-Host $linha
}

# ---------------------------------------------------------------- spooler RAW
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OttzRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);

  // Devolve o id do job no spooler do Windows.
  public static int Enviar(string impressora, string titulo, byte[] dados) {
    IntPtr h;
    if (!OpenPrinter(impressora, out h, IntPtr.Zero)) throw new Exception("OpenPrinter falhou (" + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = titulo; di.pDataType = "RAW";
      int job = StartDocPrinter(h, 1, di);
      if (job == 0) throw new Exception("StartDocPrinter falhou (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter falhou (" + Marshal.GetLastWin32Error() + ")");
        int escritos;
        bool ok = WritePrinter(h, dados, dados.Length, out escritos);
        EndPagePrinter(h);
        if (!ok || escritos != dados.Length) throw new Exception("WritePrinter falhou (" + Marshal.GetLastWin32Error() + ")");
      } finally { EndDocPrinter(h); }
      return job;
    } finally { ClosePrinter(h); }
  }
}
'@

function Impressoras {
  Get-CimInstance Win32_Printer |
    Where-Object { $_.Name -match $Filtro -or $_.DriverName -match $Filtro } |
    ForEach-Object {
      [pscustomobject]@{
        nome    = $_.Name
        driver  = $_.DriverName
        status  = $_.PrinterStatus
        offline = [bool]($_.WorkOffline -or $_.PrinterStatus -eq 7)
      }
    }
}

function Imprimir($job) {
  $nome = [string]$job.impressora
  $p = Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $nome }
  if (-not $p) { return @{ id = $job.id; ok = $false; erro = "impressora '$nome' nao existe neste PC" } }
  if ($p.WorkOffline -or $p.PrinterStatus -eq 7) { return @{ id = $job.id; ok = $false; erro = 'impressora offline (nada enviado)' } }

  $bytes = [Convert]::FromBase64String([string]$job.conteudo_b64)
  $titulo = if ($job.titulo) { [string]$job.titulo } else { "Ottz job $($job.id)" }
  try { $spool = [OttzRaw]::Enviar($nome, $titulo, $bytes) }
  catch { return @{ id = $job.id; ok = $false; erro = "envio: $($_.Exception.Message)" } }

  # Espera o spooler entregar os dados a impressora (sai da fila do Windows).
  $limite = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $limite) {
    $pj = Get-PrintJob -PrinterName $nome -ID $spool -ErrorAction SilentlyContinue
    if (-not $pj) { return @{ id = $job.id; ok = $true } }
    if ([string]$pj.JobStatus -match 'Error|Offline|PaperOut|Blocked|UserIntervention') {
      Remove-PrintJob -PrinterName $nome -ID $spool -ErrorAction SilentlyContinue
      return @{ id = $job.id; ok = $false; erro = "impressora: $($pj.JobStatus) — job cancelado no Windows, conferir na bancada" }
    }
    Start-Sleep -Milliseconds 500
  }
  Remove-PrintJob -PrinterName $nome -ID $spool -ErrorAction SilentlyContinue
  return @{ id = $job.id; ok = $false; erro = 'nao saiu da fila do Windows em 60 s — job cancelado, conferir na bancada' }
}

function Chamar([string]$modulo, $corpo = $null, [int]$timeout = 20, [string]$extra = '') {
  $uri = "$Base`?modulo=$modulo$extra"
  if ($null -eq $corpo) { return Invoke-RestMethod -Method Get -Uri $uri -Headers $Hdr -TimeoutSec $timeout }
  $json = $corpo | ConvertTo-Json -Depth 6 -Compress
  return Invoke-RestMethod -Method Post -Uri $uri -Headers $Hdr -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec $timeout
}

function Heartbeat {
  $lista = @(Impressoras)
  $r = Chamar 'heartbeat' @{ computador = $env:COMPUTERNAME; versao = $VERSAO; impressoras = $lista }
  return $r
}

# Resultados que nao chegaram ao servidor ficam em disco ate conseguir avisar.
function EnviarResultados([object[]]$novos) {
  $todos = @()
  if (Test-Path $ArqPendentes) { $todos += @(Get-Content -Raw $ArqPendentes | ConvertFrom-Json) }
  $todos += $novos
  if (-not $todos.Count) { return }
  try {
    $r = Chamar 'concluir' @{ resultados = $todos }
    Remove-Item $ArqPendentes -ErrorAction SilentlyContinue
    Log ("concluir: {0} impressos, {1} erros" -f $r.impressos, $r.erros)
  } catch {
    $todos | ConvertTo-Json -Depth 4 | Set-Content -Path $ArqPendentes -Encoding UTF8
    Log "concluir falhou (guardado p/ reenviar): $($_.Exception.Message)"
  }
}

# ---------------------------------------------------------------- modos avulsos
if ($Listar) { Impressoras | Format-Table -AutoSize; exit 0 }
if ($Teste) {
  $p = @(Impressoras)[0]
  if (-not $p) { Write-Host "Nenhuma impressora casou com o filtro '$Filtro'."; exit 1 }
  $zpl = "^XA^CI28^FO30,40^A0N,40,40^FDOttz Impressao OK^FS^FO30,100^A0N,28,28^FD$($env:COMPUTERNAME) - $(Get-Date -Format 'dd/MM HH:mm')^FS^XZ"
  $r = Imprimir @{ id = 0; impressora = $p.nome; titulo = 'Teste Ottz'; conteudo_b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($zpl)) }
  Write-Host ("Teste em '{0}': {1}" -f $p.nome, ($(if ($r.ok) { 'OK' } else { $r.erro })))
  exit 0
}

# ---------------------------------------------------------------- loop principal
$mutex = New-Object System.Threading.Mutex($false, 'Global\OttzImpressaoAgente')
if (-not $mutex.WaitOne(0)) { Write-Host 'Ja existe um agente rodando neste PC.'; exit 0 }

Get-ChildItem $DirLog -Filter 'agente-*.log' | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -ErrorAction SilentlyContinue
Log "agente $VERSAO iniciado em $env:COMPUTERNAME (filtro '$Filtro')"
$ultimoHb = [datetime]::MinValue
$falhas = 0
while ($true) {
  try {
    if (((Get-Date) - $ultimoHb).TotalSeconds -ge 30) {
      $hb = Heartbeat
      if ($ultimoHb -eq [datetime]::MinValue) {
        Log ("registrado como '{0}': {1}" -f $hb.agente, (($hb.impressoras | ForEach-Object { "$($_.id)=$($_.nome_windows)" }) -join ', '))
      }
      $ultimoHb = Get-Date
      if (Test-Path $ArqPendentes) { EnviarResultados @() }
    }
    $r = Chamar 'aguardar' $null 40 '&espera=20&max=20'
    $jobs = @($r.jobs)
    if ($jobs.Count) {
      $res = @()
      foreach ($j in $jobs) {
        $x = Imprimir $j
        Log ("job {0} -> {1}: {2}" -f $j.id, $j.impressora, $(if ($x.ok) { 'impresso' } else { "ERRO $($x.erro)" }))
        $res += [pscustomobject]$x
      }
      EnviarResultados $res
    }
    $falhas = 0
  } catch {
    $falhas++
    Log "falha ($falhas): $($_.Exception.Message)"
    Start-Sleep -Seconds ([math]::Min(60, 5 * $falhas))
  }
}
