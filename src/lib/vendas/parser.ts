/**
 * Parser de relatório "Order.all" da Shopee (Centro do Vendedor).
 *
 * Replica a lógica de consolidar_vendas.py:
 *   - aceita .xlsx, .xls e .zip (que contém xlsx internos)
 *   - parseia datas, calcula renda estimada (subtotal - taxas - 10% imposto + ajuste - afiliados)
 *   - simplifica motivo de cancelamento
 *   - dedup por (ID do pedido) + agrega multi-SKU em 1 linha de pedido
 *   - gera 2 datasets: Pedidos (1 por pedido) e Itens (1 por SKU)
 */

import * as XLSX from "xlsx";
import JSZip from "jszip";

import type { ItemPedido, Pedido } from "./types";
import { STATUS_CANCELADOS } from "./types";

// Coluna em Excel pode vir com whitespace inconsistente — normalizamos chaves.
function normalizeKey(s: string): string {
  return String(s ?? "").trim();
}

// Lê xlsx (ArrayBuffer) e devolve linhas como objetos { col: valor }.
function lerXlsx(buf: ArrayBuffer): Record<string, unknown>[] {
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: true,
  });
  // Normaliza chaves (whitespace)
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[normalizeKey(k)] = v;
    return out;
  });
}

/** Aceita File ou Blob; expande zip em xlsx internos. */
export async function extrairXlsxDeArquivo(
  file: File
): Promise<{ nome: string; buf: ArrayBuffer }[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return [{ nome: file.name, buf: await file.arrayBuffer() }];
  }
  if (lower.endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const out: { nome: string; buf: ArrayBuffer }[] = [];
    const entries = Object.values(zip.files);
    for (const entry of entries) {
      if (entry.dir) continue;
      const n = entry.name.toLowerCase();
      if (n.endsWith(".xlsx") || n.endsWith(".xls")) {
        const buf = await entry.async("arraybuffer");
        out.push({ nome: entry.name, buf });
      }
    }
    return out;
  }
  throw new Error(`Formato não suportado: ${file.name}`);
}

// Conversão segura para número (Shopee às vezes usa string vazia).
function num(v: unknown): number {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim().replace(/[R$\s]/g, "").replace(/\./g, "_dot_").replace(",", ".").replace(/_dot_/g, "");
  // Tentativa direta primeiro
  const direct = Number(String(v).trim());
  if (Number.isFinite(direct)) return direct;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// "2025-04-15 14:32:18" ou "15/04/2025 14:32" → { data: "2025-04-15", iso }
function parsearData(v: unknown): { data: string; iso: string } {
  if (!v) return { data: "", iso: "" };
  if (typeof v === "number") {
    // Excel date serial
    const date = XLSX.SSF.parse_date_code(v);
    if (date) {
      const yyyy = String(date.y).padStart(4, "0");
      const mm = String(date.m).padStart(2, "0");
      const dd = String(date.d).padStart(2, "0");
      const HH = String(date.H ?? 0).padStart(2, "0");
      const MM = String(date.M ?? 0).padStart(2, "0");
      const SS = String(Math.floor(date.S ?? 0)).padStart(2, "0");
      const data = `${yyyy}-${mm}-${dd}`;
      return { data, iso: `${data}T${HH}:${MM}:${SS}` };
    }
  }
  const s = String(v).trim();
  // Formato Shopee comum: "2025-04-15 14:32:18"
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m1) {
    const data = `${m1[1]}-${m1[2]}-${m1[3]}`;
    const iso = `${data}T${m1[4] ?? "00"}:${m1[5] ?? "00"}:${m1[6] ?? "00"}`;
    return { data, iso };
  }
  // dd/mm/yyyy
  const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m2) {
    const data = `${m2[3]}-${m2[2]}-${m2[1]}`;
    const iso = `${data}T${m2[4] ?? "00"}:${m2[5] ?? "00"}:${m2[6] ?? "00"}`;
    return { data, iso };
  }
  return { data: "", iso: s };
}

function simplificarMotivoCancelamento(motivo: string): string {
  if (!motivo) return "";
  const s = motivo.trim();
  const idx = s.indexOf("Motivo :") !== -1 ? s.indexOf("Motivo :") + 8 : s.indexOf("Motivo:") !== -1 ? s.indexOf("Motivo:") + 7 : -1;
  if (idx === -1) return s.slice(0, 100);
  const prefixo = s.slice(0, idx - (s.indexOf("Motivo :") !== -1 ? 8 : 7)).trim().replace(/\.$/, "").trim();
  let razao = s.slice(idx).trim();
  if (razao.length > 80) razao = razao.slice(0, 80) + "...";
  let origem = "Outro";
  const lower = prefixo.toLowerCase();
  if (lower.includes("automaticamente pelo sistema")) origem = "Sistema";
  else if (lower.includes("comprador")) origem = "Comprador";
  else if (lower.includes("vendedor")) origem = "Vendedor";
  return `${origem}: ${razao}`;
}

export interface ResultadoProcessamento {
  pedidos: Pedido[];
  itens: ItemPedido[];
  arquivos_lidos: number;
  linhas_brutas: number;
  pedidos_unicos: number;
  warnings: string[];
}

/**
 * Recebe linhas brutas (já com chaves normalizadas) de 1+ arquivos.
 * Faz toda a transformação: parse de tipos, agregação multi-SKU em pedidos,
 * cálculo de derivados.
 */
export function processarLinhasBrutas(
  linhasPorArquivo: { nome: string; linhas: Record<string, unknown>[] }[]
): ResultadoProcessamento {
  const warnings: string[] = [];
  const dataImportacao = new Date().toISOString().slice(0, 16).replace("T", " ");

  // 1) Achata todas as linhas (preservando arquivo_origem)
  const todasLinhas: { row: Record<string, unknown>; arquivo: string }[] = [];
  for (const arq of linhasPorArquivo) {
    for (const row of arq.linhas) {
      todasLinhas.push({ row, arquivo: arq.nome });
    }
  }

  if (todasLinhas.length === 0) {
    return {
      pedidos: [],
      itens: [],
      arquivos_lidos: linhasPorArquivo.length,
      linhas_brutas: 0,
      pedidos_unicos: 0,
      warnings: ["Nenhuma linha encontrada nos arquivos."],
    };
  }

  // Sanity check: precisa ter "ID do pedido"
  const sample = todasLinhas[0].row;
  if (!("ID do pedido" in sample)) {
    const cols = Object.keys(sample).slice(0, 8).join(", ");
    warnings.push(
      `Coluna "ID do pedido" não encontrada. Colunas detectadas: ${cols}...`
    );
  }

  // 2) Gera ITENS (1 linha por SKU original)
  const itens: ItemPedido[] = todasLinhas.map(({ row, arquivo }) => {
    const status = str(row["Status do pedido"]);
    const { data } = parsearData(row["Data de criação do pedido"]);
    return {
      id_pedido: str(row["ID do pedido"]),
      data_pedido: data,
      produto: str(row["Nome do Produto"]),
      sku: str(row["Número de referência SKU"]),
      sku_principal: str(row["Nº de referência do SKU principal"]),
      variacao: str(row["Nome da variação"]),
      preco: num(row["Preço acordado"]),
      quantidade: num(row["Quantidade"]),
      subtotal: num(row["Subtotal do produto"]),
      desconto_vendedor: num(row["Desconto do vendedor"]),
      status,
      uf: str(row["UF"]),
      pedido_valido: !STATUS_CANCELADOS.includes(status as never),
      arquivo_origem: arquivo,
    };
  });

  // 3) Agrega por ID do pedido → 1 linha por pedido
  const grupos = new Map<string, { row: Record<string, unknown>; arquivo: string }[]>();
  for (const linha of todasLinhas) {
    const id = str(linha.row["ID do pedido"]);
    if (!id) continue;
    const arr = grupos.get(id) ?? [];
    arr.push(linha);
    grupos.set(id, arr);
  }

  const pedidos: Pedido[] = [];
  for (const [id, linhas] of grupos) {
    const head = linhas[0].row;
    const arquivo = linhas[0].arquivo;
    const status = str(head["Status do pedido"]);
    const { data, iso } = parsearData(head["Data de criação do pedido"]);

    // Agregados dos itens
    const skusUnicos = new Set<string>();
    let totalItens = 0;
    let subtotalProdutos = 0;
    let ajuste = 0;
    let afiliados = 0;
    let primeiroProduto = "";
    for (const { row } of linhas) {
      const sku = str(row["Número de referência SKU"]);
      if (sku) skusUnicos.add(sku);
      totalItens += num(row["Quantidade"]);
      subtotalProdutos += num(row["Subtotal do produto"]);
      ajuste += num(row["Ajuste por participação em ação comercial"]);
      afiliados += num(row["Taxa de comissão Afiliados do Vendedor"]);
      if (!primeiroProduto) primeiroProduto = str(row["Nome do Produto"]);
    }

    const valorTotal = num(head["Valor Total"]);
    const taxaComissao = num(head["Taxa de comissão líquida"]);
    const taxaServico = num(head["Taxa de serviço líquida"]);
    const taxaTransacao = num(head["Taxa de transação"]);

    const subtotalBase = subtotalProdutos || num(head["Subtotal do produto"]);
    const taxas = taxaComissao + taxaServico + taxaTransacao;
    const impostoEstimado = Math.round(subtotalBase * 0.1 * 100) / 100;
    const rendaEstimada =
      Math.round((subtotalBase - taxas - impostoEstimado + ajuste - afiliados) * 100) / 100;

    pedidos.push({
      id,
      status,
      status_devolucao: str(head["Status da Devolução / Reembolso"]),
      motivo_cancelamento: simplificarMotivoCancelamento(str(head["Cancelar Motivo"])),
      data_pedido: data,
      data_hora_pedido: iso,
      hora_pagamento: str(head["Hora do pagamento do pedido"]),
      fbs: str(head["Pedido FBS"]),
      metodo_envio: str(head["Método de envio"]),
      opcao_envio: str(head["Opção de envio"]),

      valor_total: valorTotal,
      total_global: num(head["Total global"]),
      taxa_envio_comprador: num(head["Taxa de envio pagas pelo comprador"]),
      taxa_transacao: taxaTransacao,
      taxa_comissao: taxaComissao,
      taxa_servico: taxaServico,
      cupom_vendedor: num(head["Cupom do vendedor"]),
      cupom_shopee: num(head["Cupom Shopee"]),
      desconto_cartao: num(head["Total descontado Cartão de Crédito"]),

      n_skus: skusUnicos.size || 1,
      total_itens: totalItens,
      primeiro_produto: primeiroProduto,
      subtotal_produtos: Math.round(subtotalBase * 100) / 100,
      ajuste_acao_comercial: Math.round(ajuste * 100) / 100,
      comissao_afiliados: Math.round(afiliados * 100) / 100,

      pedido_valido: !STATUS_CANCELADOS.includes(status as never),
      imposto_estimado: impostoEstimado,
      renda_estimada: rendaEstimada,

      cidade: str(head["Cidade.1"]) || str(head["Cidade"]),
      uf: str(head["UF"]),
      cep: str(head["CEP"]),
      destinatario: str(head["Nome do destinatário"]),

      arquivo_origem: arquivo,
      data_importacao: dataImportacao,
    });
  }

  return {
    pedidos,
    itens,
    arquivos_lidos: linhasPorArquivo.length,
    linhas_brutas: todasLinhas.length,
    pedidos_unicos: pedidos.length,
    warnings,
  };
}

/** Pipeline completo: arquivos → pedidos+itens prontos. */
export async function processarArquivosVendas(
  files: File[]
): Promise<ResultadoProcessamento> {
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
          warnings.push(`${x.nome}: erro ao ler — ${(e as Error).message}`);
        }
      }
    } catch (e) {
      warnings.push(`${file.name}: ${(e as Error).message}`);
    }
  }

  const resultado = processarLinhasBrutas(linhasPorArquivo);
  resultado.warnings.unshift(...warnings);
  return resultado;
}
