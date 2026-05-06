/**
 * Parser do extrato Shopee "Minha Carteira → Extrato"
 * (balance_transaction_report.shopee.*.xlsx).
 *
 * Estrutura observada:
 *  - linhas 0..16 = cabeçalho do relatório (informações da conta + resumo)
 *  - linha com "Data | Tipo de transação | Descrição | ID do pedido | Direção do dinheiro | Valor | Status | Balança após as transações | Valor a Ser Ajustado"
 *  - depois disso, 1 linha por transação
 */

import * as XLSX from "xlsx";
import type { TransacaoCarteira } from "./types";

const HEADERS = [
  "data",
  "tipo de transacao",
  "descricao",
  "id do pedido",
  "direcao do dinheiro",
  "valor",
  "status",
  "balanca apos as transacoes",
  "valor a ser ajustado",
];

function norm(s: unknown): string {
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

function parseDataHora(v: unknown): { iso: string; data: string } {
  const s = str(v);
  if (!s) return { iso: "", data: "" };
  // "2026-05-03 23:19:30" já está no formato esperado
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (m) return { iso: `${m[1]} ${m[2]}`, data: m[1] };
  // Tentativa alternativa: Date
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const iso = d.toISOString().replace("T", " ").slice(0, 19);
    return { iso, data: iso.slice(0, 10) };
  }
  return { iso: s, data: s.slice(0, 10) };
}

export interface ResultadoCarteiraProcessamento {
  rows: TransacaoCarteira[];
  arquivos_lidos: number;
  warnings: string[];
}

export async function processarArquivosCarteira(
  files: File[]
): Promise<ResultadoCarteiraProcessamento> {
  const warnings: string[] = [];
  const rows: TransacaoCarteira[] = [];
  const dataImportacao = new Date().toISOString().slice(0, 16).replace("T", " ");
  let arquivosLidos = 0;

  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls") && !lower.endsWith(".csv")) {
      warnings.push(`${file.name}: formato não suportado (use .xlsx/.xls/.csv)`);
      continue;
    }

    try {
      const buf = await file.arrayBuffer();
      let wb: XLSX.WorkBook;
      if (lower.endsWith(".csv")) {
        const text = new TextDecoder("utf-8").decode(buf);
        wb = XLSX.read(text, { type: "string" });
      } else {
        wb = XLSX.read(buf, { type: "array" });
      }

      // Procura aba com mais linhas
      let melhor: unknown[][] = [];
      for (const aba of wb.SheetNames) {
        const sheet = wb.Sheets[aba];
        if (!sheet) continue;
        const arr = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
          header: 1,
          defval: null,
          raw: false,
        });
        if (arr.length > melhor.length) melhor = arr;
      }
      if (melhor.length === 0) {
        warnings.push(`${file.name}: planilha vazia`);
        continue;
      }

      // Localiza linha de cabeçalho
      let headerIdx = -1;
      for (let i = 0; i < Math.min(melhor.length, 50); i++) {
        const linha = (melhor[i] || []).map(norm);
        if (
          linha.includes("data") &&
          linha.some((c) => c.includes("tipo de transa")) &&
          linha.some((c) => c.includes("id do pedido"))
        ) {
          headerIdx = i;
          break;
        }
      }
      if (headerIdx === -1) {
        warnings.push(
          `${file.name}: cabeçalho do extrato não encontrado (esperado "Data / Tipo de transação / ID do pedido")`
        );
        continue;
      }

      // Mapeia índices das colunas
      const headerRow = (melhor[headerIdx] || []).map(norm);
      const idx: Record<string, number> = {};
      for (const h of HEADERS) {
        idx[h] = headerRow.findIndex((c) => c === h || c.startsWith(h));
      }
      if (idx["data"] < 0 || idx["valor"] < 0) {
        warnings.push(`${file.name}: colunas obrigatórias ausentes`);
        continue;
      }

      let antes = rows.length;
      for (let i = headerIdx + 1; i < melhor.length; i++) {
        const r = melhor[i] || [];
        if (!r[idx["data"]]) continue;

        const { iso, data } = parseDataHora(r[idx["data"]]);
        if (!iso) continue;

        const tipo = str(r[idx["tipo de transacao"]]);
        const descricao = str(r[idx["descricao"]]);
        let id_pedido = str(r[idx["id do pedido"]]);
        if (id_pedido === "-" || id_pedido.toLowerCase() === "nan") id_pedido = "";
        const direcaoRaw = norm(r[idx["direcao do dinheiro"]]);
        const direcao: "Entrada" | "Saída" =
          direcaoRaw.startsWith("entr") ? "Entrada" : "Saída";
        let valor = num(r[idx["valor"]]);
        // Garante sinal: saída sempre negativa, entrada positiva
        valor = direcao === "Saída" ? -Math.abs(valor) : Math.abs(valor);

        const status = str(r[idx["status"]]);
        const saldo_apos = num(r[idx["balanca apos as transacoes"]]);

        const chave = `${iso}|${id_pedido}|${valor.toFixed(2)}|${tipo}`;

        rows.push({
          chave,
          data_hora: iso,
          data,
          tipo,
          descricao,
          id_pedido,
          direcao,
          valor,
          status,
          saldo_apos,
          arquivo_origem: file.name,
          data_importacao: dataImportacao,
        });
      }

      arquivosLidos++;
      const novos = rows.length - antes;
      if (novos === 0) {
        warnings.push(`${file.name}: 0 transações extraídas`);
      }
    } catch (e) {
      warnings.push(`${file.name}: erro — ${(e as Error).message}`);
    }
  }

  // Dedup por chave
  const map = new Map<string, TransacaoCarteira>();
  for (const r of rows) map.set(r.chave, r);

  return {
    rows: Array.from(map.values()).sort((a, b) =>
      a.data_hora < b.data_hora ? 1 : -1
    ),
    arquivos_lidos: arquivosLidos,
    warnings,
  };
}
