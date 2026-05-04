/**
 * Parser do CMV (Custo da Mercadoria Vendida).
 *
 * Suporta dois formatos:
 *  - Simples: planilha com colunas `sku` e `valor`
 *  - Tiny ERP: planilha com `Código (SKU)`, `Preço de custo` (+ opcionais
 *    Descrição, Preço, Categoria, Marca, Fornecedor)
 *
 * Aceita .xlsx, .xls e .csv.
 */

import * as XLSX from "xlsx";
import type { CmvRow } from "./types";

function normalize(s: string): string {
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
  let s = String(v).trim().replace(/r\$/gi, "").replace(/\s/g, "");
  if (!s) return 0;
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  const ptbr = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(ptbr) ? ptbr : 0;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function lerWorkbook(buf: ArrayBuffer, nome: string): Record<string, unknown>[] {
  const isCsv = nome.toLowerCase().endsWith(".csv");
  let wb: XLSX.WorkBook;
  if (isCsv) {
    const text = new TextDecoder("utf-8").decode(buf);
    wb = XLSX.read(text, { type: "string", cellDates: false });
  } else {
    wb = XLSX.read(buf, { type: "array", cellDates: false });
  }
  // Pega aba com mais linhas
  let melhor: Record<string, unknown>[] = [];
  for (const aba of wb.SheetNames) {
    const sheet = wb.Sheets[aba];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
    });
    if (rows.length > melhor.length) melhor = rows;
  }
  return melhor;
}

export interface ResultadoCmvProcessamento {
  rows: CmvRow[];
  arquivos_lidos: number;
  warnings: string[];
}

export async function processarArquivosCmv(
  files: File[]
): Promise<ResultadoCmvProcessamento> {
  const warnings: string[] = [];
  const rows: CmvRow[] = [];
  const dataImportacao = new Date().toISOString().slice(0, 16).replace("T", " ");
  let arquivosLidos = 0;

  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (
      !lower.endsWith(".xlsx") &&
      !lower.endsWith(".xls") &&
      !lower.endsWith(".csv")
    ) {
      warnings.push(`${file.name}: formato não suportado (use .xlsx/.xls/.csv)`);
      continue;
    }

    try {
      const buf = await file.arrayBuffer();
      const linhas = lerWorkbook(buf, file.name);
      if (linhas.length === 0) {
        warnings.push(`${file.name}: planilha vazia`);
        continue;
      }

      // Detecta colunas
      const cabecalhos = Object.keys(linhas[0]);
      const colMap: Record<string, string | undefined> = {};
      for (const c of cabecalhos) {
        const n = normalize(c);
        if (n === "sku" && !colMap.sku) colMap.sku = c;
        if (n === "valor" && !colMap.valor) colMap.valor = c;
        if (n.includes("codigo") && n.includes("sku")) colMap.tinySku = c;
        if (n.includes("preco de custo")) colMap.tinyCusto = c;
        if (n === "descricao") colMap.tinyDesc = c;
        if (n === "preco") colMap.tinyPreco = c;
        if (n.includes("categoria")) colMap.tinyCat = c;
        if (n.includes("marca")) colMap.tinyMarca = c;
        if (n.includes("fornecedor")) colMap.tinyForn = c;
      }

      // Formato simples
      let formato = "";
      let countAntes = rows.length;

      if (colMap.sku && colMap.valor) {
        formato = "simples";
        for (const r of linhas) {
          const sku = str(r[colMap.sku]);
          const cmv = num(r[colMap.valor]);
          if (!sku || ["nan", "none", "<na>"].includes(sku.toLowerCase())) continue;
          if (cmv <= 0) continue;
          rows.push({
            sku,
            cmv,
            formato_origem: formato,
            arquivo_origem: file.name,
            data_importacao: dataImportacao,
          });
        }
      } else if (colMap.tinySku && colMap.tinyCusto) {
        formato = "Tiny ERP";
        for (const r of linhas) {
          const sku = str(r[colMap.tinySku]);
          const cmv = num(r[colMap.tinyCusto]);
          if (!sku || ["nan", "none", "<na>"].includes(sku.toLowerCase())) continue;
          if (cmv <= 0) continue;
          rows.push({
            sku,
            cmv,
            nome_erp: colMap.tinyDesc ? str(r[colMap.tinyDesc]) : undefined,
            preco_venda_erp: colMap.tinyPreco ? num(r[colMap.tinyPreco]) : undefined,
            categoria: colMap.tinyCat ? str(r[colMap.tinyCat]) : undefined,
            marca: colMap.tinyMarca ? str(r[colMap.tinyMarca]) : undefined,
            fornecedor: colMap.tinyForn ? str(r[colMap.tinyForn]) : undefined,
            formato_origem: formato,
            arquivo_origem: file.name,
            data_importacao: dataImportacao,
          });
        }
      } else {
        warnings.push(
          `${file.name}: formato não reconhecido. Esperado colunas (sku, valor) OU (Código (SKU), Preço de custo)`
        );
        continue;
      }

      arquivosLidos++;
      const novos = rows.length - countAntes;
      if (novos === 0) {
        warnings.push(`${file.name}: 0 SKUs válidos extraídos (formato ${formato})`);
      }
    } catch (e) {
      warnings.push(`${file.name}: erro — ${(e as Error).message}`);
    }
  }

  // Dedup por SKU (mantém última ocorrência)
  const map = new Map<string, CmvRow>();
  for (const r of rows) map.set(r.sku, r);

  return {
    rows: Array.from(map.values()).sort((a, b) => a.sku.localeCompare(b.sku)),
    arquivos_lidos: arquivosLidos,
    warnings,
  };
}
