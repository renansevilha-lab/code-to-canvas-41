/**
 * Upload "inteligente": detecta o tipo de cada arquivo e roteia para o parser
 * certo. Salva em IndexedDB (local) E sincroniza com Lovable Cloud.
 */

import { detectarTipo, ROTULOS, type TipoArquivo } from "./detectarTipo";

import { processarArquivosVendas } from "@/lib/vendas/parser";
import { salvarItens, salvarPedidos } from "@/lib/vendas/storage";

import { processarArquivosAds } from "@/lib/ads/parser";
import { salvarAds } from "@/lib/ads/storage";

import { processarArquivosCmv } from "@/lib/cmv/parser";
import { salvarCmv } from "@/lib/cmv/storage";

import { processarArquivosCarteira } from "@/lib/carteira/parser";
import { salvarCarteira } from "@/lib/carteira/storage";

import {
  syncVendas,
  syncAds,
  syncCmv,
  syncCarteira,
} from "@/lib/cloud/sync";

export interface ResultadoSmart {
  tipo: TipoArquivo | "desconhecido";
  arquivos: string[];
  resumo: string;
  warnings: string[];
  cloud?: { ok: boolean; error?: string };
}

export async function processarArquivosSmart(
  files: File[]
): Promise<ResultadoSmart[]> {
  const grupos = new Map<TipoArquivo | "desconhecido", File[]>();
  for (const f of files) {
    const t = (await detectarTipo(f)) ?? "desconhecido";
    const arr = grupos.get(t) ?? [];
    arr.push(f);
    grupos.set(t, arr);
  }

  const out: ResultadoSmart[] = [];

  for (const [tipo, fs] of grupos) {
    const nomes = fs.map((f) => f.name);
    if (tipo === "vendas") {
      const r = await processarArquivosVendas(fs);
      const { novos, atualizados } = await salvarPedidos(r.pedidos);
      await salvarItens(r.itens);
      const cloud = await syncVendas(r.pedidos, r.itens);
      out.push({
        tipo,
        arquivos: nomes,
        resumo: `${r.pedidos_unicos} pedidos (${novos} novos, ${atualizados} atualizados) · ${r.itens.length} SKUs`,
        warnings: r.warnings,
        cloud,
      });
    } else if (tipo === "ads") {
      const r = await processarArquivosAds(fs);
      const { novos, atualizados } = await salvarAds(r.rows);
      const cloud = await syncAds(r.rows);
      out.push({
        tipo,
        arquivos: nomes,
        resumo: `${r.rows.length} linhas de anúncios (${novos} novas, ${atualizados} atualizadas)`,
        warnings: r.warnings,
        cloud,
      });
    } else if (tipo === "cmv") {
      const r = await processarArquivosCmv(fs);
      const { novos, atualizados } = await salvarCmv(r.rows);
      const cloud = await syncCmv(r.rows);
      out.push({
        tipo,
        arquivos: nomes,
        resumo: `${r.rows.length} SKUs com CMV (${novos} novos, ${atualizados} atualizados)`,
        warnings: r.warnings,
        cloud,
      });
    } else if (tipo === "carteira") {
      const r = await processarArquivosCarteira(fs);
      const { novos, atualizados } = await salvarCarteira(r.rows);
      const cloud = await syncCarteira(r.rows);
      out.push({
        tipo,
        arquivos: nomes,
        resumo: `${r.rows.length} transações da carteira (${novos} novas, ${atualizados} atualizadas)`,
        warnings: r.warnings,
        cloud,
      });
    } else if (tipo === "produtos") {
      out.push({
        tipo,
        arquivos: nomes,
        resumo: `Detectado como ${ROTULOS[tipo]}, mas o módulo ainda não está implementado.`,
        warnings: [],
      });
    } else {
      out.push({
        tipo: "desconhecido",
        arquivos: nomes,
        resumo:
          "Não foi possível identificar o tipo destes arquivos. Use o upload da página específica do módulo.",
        warnings: [],
      });
    }
  }

  return out;
}
