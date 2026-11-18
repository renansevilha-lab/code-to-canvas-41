// Abre a ordem de compra no layout Bumi numa aba e manda imprimir (o usuário escolhe
// "Salvar como PDF"). Serve para OC do Tiny e para rascunho do app (SUG-…). Lê a ordem,
// os itens, as fotos dos produtos e o cadastro do fornecedor que veio do Tiny junto com
// as notas de entrada (compras_nf_entrada.raw → cliente). O HTML é o de ordemCompraHtml.ts.
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { escreverEImprimir } from "@/components/producao/folhaControle";
import { COMPRADOR_PADRAO, ordemCompraHtml, type OcItem, type OcParte } from "./ordemCompraHtml";

const dataBR = (iso: string | null | undefined) => {
  if (!iso) return null;
  const [a, m, d] = iso.slice(0, 10).split("-");
  return a && m && d ? `${d}/${m}/${a}` : null;
};

type ClienteTiny = {
  nome?: string; cpfCnpj?: string; inscricaoEstadual?: string; telefone?: string; celular?: string | null;
  endereco?: { endereco?: string; numero?: string; complemento?: string; bairro?: string; municipio?: string; uf?: string; cep?: string };
};

function fornecedorDoCadastro(nome: string, c: ClienteTiny | null): OcParte {
  if (!c) return { razao: nome };
  const e = c.endereco ?? {};
  const rua = [e.endereco, e.numero, e.complemento].filter(Boolean).join(", ");
  return {
    razao: c.nome || nome,
    cnpj: c.cpfCnpj || null,
    ie: c.inscricaoEstadual || null,
    endereco: [rua, e.bairro].filter(Boolean).join(" · ") || null,
    cidade: [e.municipio && e.uf ? `${e.municipio}/${e.uf}` : e.municipio, e.cep ? `CEP ${e.cep}` : null].filter(Boolean).join(" · ") || null,
    contato: c.telefone || c.celular || null,
  };
}

/** Abre a aba no clique (antes de qualquer await) e depois escreve a ordem nela. */
export async function imprimirOrdemCompra(tinyId: number): Promise<void> {
  const w = window.open("", "_blank");
  if (!w) throw new Error("O navegador bloqueou a nova aba. Libere pop-ups para este site e tente de novo.");
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Gerando a ordem…</title><p style="font-family:system-ui;padding:24px;color:#555">Gerando a ordem de compra…</p>`);
  try {
    const { data: ordem, error: e1 } = await supabaseExternal.from("compras_ordens")
      .select("tiny_id, numero, data_pedido, data_prevista, fornecedor_id, fornecedor_nome, fornecedor_fantasia").eq("tiny_id", tinyId).maybeSingle();
    if (e1) throw e1;
    if (!ordem) throw new Error("Ordem não encontrada.");
    const { data: itens, error: e2 } = await supabaseExternal.from("compra_ordem_itens")
      .select("sku, descricao, gtin, quantidade, preco, emb_tipo, emb_unidades, so_na_nf").eq("ordem_tiny_id", tinyId).order("descricao");
    if (e2) throw e2;
    const lista = (itens ?? []).filter((i) => !i.so_na_nf);
    const skus = [...new Set(lista.map((i) => i.sku).filter(Boolean))] as string[];

    const [prodQ, nfQ, cfgQ] = await Promise.all([
      skus.length ? supabaseExternal.from("produtos").select("sku, nome, gtin, foto_capa").in("sku", skus) : Promise.resolve({ data: [], error: null }),
      ordem.fornecedor_id
        ? supabaseExternal.from("compras_nf_entrada").select("cliente:raw->cliente").eq("fornecedor_id", ordem.fornecedor_id)
          .not("raw", "is", null).order("data_emissao", { ascending: false }).limit(1)
        : Promise.resolve({ data: [], error: null }),
      ordem.fornecedor_nome
        ? supabaseExternal.from("compras_config_fornecedor").select("frete_regra").eq("fornecedor_nome", ordem.fornecedor_nome).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const prod = new Map(((prodQ.data ?? []) as Array<{ sku: string; nome: string | null; gtin: string | null; foto_capa: string | null }>).map((p) => [p.sku, p]));
    const cliente = ((nfQ.data ?? []) as Array<{ cliente: ClienteTiny | null }>)[0]?.cliente ?? null;
    const freteCfg = (cfgQ.data as { frete_regra?: string | null } | null)?.frete_regra?.trim();

    const ocItens: OcItem[] = lista.map((i) => {
      const p = i.sku ? prod.get(i.sku) : undefined;
      const qtd = Number(i.quantidade) || 0;
      const porEmb = Number(i.emb_unidades) || 0;
      const fardos = porEmb > 1 && qtd % porEmb === 0 ? qtd / porEmb : null;
      const tipo = i.emb_tipo === "caixa" ? "caixa" : "fardo";
      return {
        sku: i.sku ?? "—",
        produto: i.descricao || p?.nome || i.sku || "Produto",
        gtin: i.gtin || p?.gtin || null,
        qtd, un: "UN", valor: Number(i.preco) || 0,
        foto: p?.foto_capa || null,
        detalhe: fardos ? `${fardos.toLocaleString("pt-BR")} ${tipo}${fardos === 1 ? "" : "s"} de ${porEmb} un` : null,
        fardos,
      };
    });

    const html = ordemCompraHtml({
      numero: ordem.tiny_id > 0 ? ordem.numero : null,
      referencia: ordem.tiny_id > 0 ? null : ordem.numero,
      emissao: dataBR(ordem.data_pedido) ?? new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      comprador: COMPRADOR_PADRAO,
      fornecedor: fornecedorDoCadastro(ordem.fornecedor_fantasia?.trim() || ordem.fornecedor_nome || "Fornecedor", cliente),
      condicoes: {
        pagamento: "A combinar",
        frete: freteCfg && !/confirmar/i.test(freteCfg) ? freteCfg : "A combinar",
        previsao: dataBR(ordem.data_prevista) ?? "A combinar",
        comprador: COMPRADOR_PADRAO.responsavel ?? "Comprador",
      },
      itens: ocItens,
      logoUrl: `${window.location.origin}/logos/logotipo-bumi.png`,
    });
    escreverEImprimir(w, html);
  } catch (e) {
    w.document.open();
    w.document.write(`<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:24px;color:#b00">Não deu para gerar a ordem: ${String((e as Error).message ?? e).replace(/</g, "&lt;")}</p>`);
    w.document.close();
    throw e;
  }
}
