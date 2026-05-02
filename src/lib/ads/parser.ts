/**
 * Parser do relatório "Dados Gerais de Anúncios" do Painel da Shopee.
 *
 * Formatos suportados:
 *   - .xlsx / .xls (1 aba com cabeçalho)
 *   - .zip contendo xlsx internos
 *
 * Robusto a variações de nomes de coluna (case-insensitive, com aliases)
 * porque a Shopee muda o cabeçalho com frequência.
 */

import * as XLSX from "xlsx";
import JSZip from "jszip";

import type { AdRow } from "./types";

// ─── Util ─────────────────────────────────────────────────────────────────

function normalizeKey(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  // Remove R$, %, espaços
  s = s.replace(/r\$/gi, "").replace(/%/g, "").replace(/\s/g, "");
  // Tenta direto
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Formato brasileiro: 1.234,56
  const ptbr = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(ptbr) ? ptbr : 0;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function parsearData(v: unknown): string {
  if (!v) return "";
  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) {
      return `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
  }
  const s = String(v).trim();
  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD/MM/YYYY
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  // YYYY/MM/DD
  m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return "";
}

// ─── Lookup de colunas com aliases ────────────────────────────────────────

const ALIASES: Record<string, string[]> = {
  data: ["data", "data do relatorio", "dia", "date"],
  nome_anuncio: [
    "nome do anuncio",
    "anuncio",
    "produto",
    "nome do produto",
    "ad name",
  ],
  id_anuncio: ["id do anuncio", "id anuncio", "id do produto", "sku", "ad id"],
  tipo_anuncio: [
    "tipo de anuncio",
    "tipos de anuncios",
    "tipos de anuncio",
    "tipo",
    "modo de lance",
    "ad type",
  ],
  status: ["status", "status do anuncio"],
  impressoes: ["impressoes", "impressions", "exibicoes"],
  cliques: ["cliques", "clicks", "clique"],
  pedidos: [
    "pedidos",
    "orders",
    "n° de pedidos",
    "numero de pedidos",
    "conversoes",
    "conversions",
  ],
  itens_vendidos: ["itens vendidos", "produtos vendidos", "qtd vendida", "items sold"],
  gmv: [
    "vendas",
    "vendas (gmv)",
    "vendas (r$)",
    "gmv",
    "vendas atribuidas",
    "vendas direto e indireto",
    "valor de vendas",
  ],
  gasto: [
    "gasto",
    "gasto (r$)",
    "custo",
    "investimento",
    "spend",
    "valor gasto",
    "despesas",
    "despesa",
  ],
};

/** Cria lookup de chave normalizada → chave canônica do nosso modelo. */
function buildColMap(linhas: Record<string, unknown>[]): Map<string, string> {
  const map = new Map<string, string>();
  if (linhas.length === 0) return map;
  const cabecalhos = Object.keys(linhas[0]);
  for (const cab of cabecalhos) {
    const norm = normalizeKey(cab);
    for (const [canon, aliases] of Object.entries(ALIASES)) {
      if (aliases.includes(norm)) {
        // Não sobrescreve — a primeira coluna que bate vence
        if (!map.has(canon)) map.set(canon, cab);
        break;
      }
    }
  }
  return map;
}

function get(row: Record<string, unknown>, colMap: Map<string, string>, canon: string): unknown {
  const k = colMap.get(canon);
  return k ? row[k] : "";
}

// ─── Leitura de arquivos ──────────────────────────────────────────────────

function lerArquivo(buf: ArrayBuffer, nome: string): Record<string, unknown>[] {
  const isCsv = nome.toLowerCase().endsWith(".csv");
  let wb: XLSX.WorkBook;
  if (isCsv) {
    // Decodifica como UTF-8 (o relatório da Shopee tem BOM)
    const text = new TextDecoder("utf-8").decode(buf);
    wb = XLSX.read(text, { type: "string", cellDates: false });
  } else {
    wb = XLSX.read(buf, { type: "array", cellDates: false });
  }
  // Procura aba com mais linhas (Shopee às vezes inclui aba "Resumo")
  let melhor: { rows: Record<string, unknown>[]; n: number } = { rows: [], n: 0 };
  for (const nomeAba of wb.SheetNames) {
    const sheet = wb.Sheets[nomeAba];
    if (!sheet) continue;
    // Tenta detectar header se as primeiras linhas forem metadados
    const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
    let headerIdx = 0;
    for (let i = 0; i < Math.min(raw.length, 12); i++) {
      const linha = (raw[i] || []).map((c) => normalizeKey(String(c)));
      if (
        linha.some((c) =>
          [
            "impressoes",
            "cliques",
            "vendas",
            "vendas (gmv)",
            "gasto",
            "gmv",
            "despesas",
            "nome do anuncio",
          ].includes(c)
        )
      ) {
        headerIdx = i;
        break;
      }
    }
    const header = (raw[headerIdx] || []).map((c) => String(c).trim());
    const body = raw.slice(headerIdx + 1);
    const rows: Record<string, unknown>[] = [];
    for (const r of body) {
      if (!Array.isArray(r) || r.every((c) => c === "" || c === null)) continue;
      const obj: Record<string, unknown> = {};
      header.forEach((h, i) => {
        if (h) obj[h] = r[i];
      });
      rows.push(obj);
    }
    if (rows.length > melhor.n) melhor = { rows, n: rows.length };
  }
  return melhor.rows;
}

export async function extrairXlsxDeArquivo(
  file: File
): Promise<{ nome: string; buf: ArrayBuffer }[]> {
  const lower = file.name.toLowerCase();
  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".csv")
  ) {
    return [{ nome: file.name, buf: await file.arrayBuffer() }];
  }
  if (lower.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const out: { nome: string; buf: ArrayBuffer }[] = [];
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const n = entry.name.toLowerCase();
      if (n.endsWith(".xlsx") || n.endsWith(".xls") || n.endsWith(".csv")) {
        out.push({ nome: entry.name, buf: await entry.async("arraybuffer") });
      }
    }
    return out;
  }
  throw new Error(`Formato não suportado: ${file.name}`);
}

// ─── Pipeline ─────────────────────────────────────────────────────────────

export interface ResultadoAdsProcessamento {
  rows: AdRow[];
  arquivos_lidos: number;
  linhas_brutas: number;
  warnings: string[];
}

/** Tenta inferir uma data do nome do arquivo (ex: "ads_2025-04-01_2025-04-30.xlsx" ou "...30_04_2026-30_04_2026.csv"). */
function inferirDataDoNome(nome: string): string {
  // Pega a última ocorrência (data final do período)
  const matches = [...nome.matchAll(/(\d{2})[-_/](\d{2})[-_/](\d{4})/g)];
  if (matches.length > 0) {
    const m = matches[matches.length - 1];
    return `${m[3]}-${m[2]}-${m[1]}`;
  }
  const iso = nome.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return "";
}

export function processarLinhasAds(
  linhasPorArquivo: { nome: string; linhas: Record<string, unknown>[] }[]
): ResultadoAdsProcessamento {
  const warnings: string[] = [];
  const dataImportacao = new Date().toISOString().slice(0, 16).replace("T", " ");
  const rows: AdRow[] = [];

  for (const arq of linhasPorArquivo) {
    const colMap = buildColMap(arq.linhas);

    if (colMap.size === 0) {
      warnings.push(`${arq.nome}: cabeçalho não reconhecido`);
      continue;
    }
    if (!colMap.has("gasto") && !colMap.has("impressoes")) {
      warnings.push(`${arq.nome}: nenhuma métrica de anúncio detectada`);
      continue;
    }

    const dataDoNome = inferirDataDoNome(arq.nome);

    for (let i = 0; i < arq.linhas.length; i++) {
      const r = arq.linhas[i];
      const nome = str(get(r, colMap, "nome_anuncio"));
      const idAd = str(get(r, colMap, "id_anuncio"));

      // Pula linhas de total/em branco
      if (!nome && !idAd) continue;
      if (/^total|^totais/i.test(nome)) continue;

      const dataLinha = parsearData(get(r, colMap, "data")) || dataDoNome;

      const impressoes = num(get(r, colMap, "impressoes"));
      const cliques = num(get(r, colMap, "cliques"));
      const pedidos = num(get(r, colMap, "pedidos"));
      const itensVendidos = num(get(r, colMap, "itens_vendidos"));
      const gmv = num(get(r, colMap, "gmv"));
      const gasto = num(get(r, colMap, "gasto"));

      // Pula linhas totalmente vazias (sem nenhuma métrica)
      if (
        impressoes === 0 &&
        cliques === 0 &&
        gasto === 0 &&
        gmv === 0 &&
        pedidos === 0
      ) {
        continue;
      }

      const id = idAd || nome;
      const chave = `${id}|${dataLinha || arq.nome}|${i}`;

      rows.push({
        chave,
        data: dataLinha,
        id_anuncio: id,
        nome_anuncio: nome || id,
        tipo_anuncio: str(get(r, colMap, "tipo_anuncio")),
        status: str(get(r, colMap, "status")),

        impressoes,
        cliques,
        pedidos,
        itens_vendidos: itensVendidos,
        gmv,
        gasto,

        ctr_pct: impressoes > 0 ? (cliques / impressoes) * 100 : 0,
        cpc: cliques > 0 ? gasto / cliques : 0,
        cpa: pedidos > 0 ? gasto / pedidos : 0,
        roas: gasto > 0 ? gmv / gasto : 0,
        taxa_conversao_pct: cliques > 0 ? (pedidos / cliques) * 100 : 0,
        ticket_medio: pedidos > 0 ? gmv / pedidos : 0,

        arquivo_origem: arq.nome,
        data_importacao: dataImportacao,
      });
    }
  }

  return {
    rows,
    arquivos_lidos: linhasPorArquivo.length,
    linhas_brutas: linhasPorArquivo.reduce((s, a) => s + a.linhas.length, 0),
    warnings,
  };
}

export async function processarArquivosAds(files: File[]): Promise<ResultadoAdsProcessamento> {
  const linhasPorArquivo: { nome: string; linhas: Record<string, unknown>[] }[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    try {
      const xlsxs = await extrairXlsxDeArquivo(file);
      for (const x of xlsxs) {
        try {
          const linhas = lerXlsx(x.buf);
          if (linhas.length === 0) {
            warnings.push(`${x.nome}: 0 linhas lidas`);
            continue;
          }
          linhasPorArquivo.push({ nome: x.nome, linhas });
        } catch (e) {
          warnings.push(`${x.nome}: erro — ${(e as Error).message}`);
        }
      }
    } catch (e) {
      warnings.push(`${file.name}: ${(e as Error).message}`);
    }
  }

  const resultado = processarLinhasAds(linhasPorArquivo);
  resultado.warnings.unshift(...warnings);
  return resultado;
}
