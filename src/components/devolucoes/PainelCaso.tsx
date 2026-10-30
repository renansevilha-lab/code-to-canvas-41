// ============================================================================
// Painel lateral do caso (aba "Pede resposta" de /devolucoes, 29/out/2026).
// Tudo que já sabemos do caso em uma chamada (RPC devolucao_caso) + o bloco de
// resposta: causa interna (obrigatória), sugestões do histórico/modelos e as
// ações do marketplace. Shopee: aprovar / disputar pelos módulos que já
// existiam na shopee-devolucao-probe (responder-reembolsar, motivos-disputa,
// converter-imagem, responder-disputar). Mercado Livre: por enquanto a ação é
// feita no painel do ML e REGISTRADA aqui (a escrita pela API é o passo 4 do
// plano). Toda resposta vai para devolucao_resposta — é o que ensina o sistema.
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { usePerfil } from "@/hooks/usePerfil";
import { Botao, Campo, Entrada, Escolha, Selo } from "@/components/producao/ui";
import { Foto, Spinner } from "@/components/separacao/ui/kit";
import { InfoDevolucaoCampos } from "@/components/InfoDevolucaoShopee";
import type { InfoDevolucao } from "@/lib/shopeeDevolucao";
import { AcoesMl } from "./AcoesMl";
import {
  acaoEsperada, arquivoParaBase64, brl, chamarShopee, contarUsoModelo, dia, diaHora, lerCaso, lerSugestoes, linkMarketplace, lojaDe,
  marcarCausaNaEntrada, motivoPt, prazoTexto, registrarResposta, salvarModelo, GRUPO_CAUSA_PT, SOLUCAO_PT,
  type AcaoResposta, type CasoFila, type Causa,
} from "@/lib/devolucoes";

const ESTADO_ITEM_PT: Record<string, string> = { ok: "ok", furado: "furado", faltando: "faltando", quebrado: "quebrado", errado: "errado", vazado: "vazado" };

interface MotivoDisputa {
  dispute_reason: number;
  dispute_requirement: string | null;
  evidence_module_list?: { module_index: number; requirement: string; is_required: boolean }[];
}

const secao = (t: string) => (
  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--pm-t3)", margin: "14px 0 6px" }}>{t}</div>
);
const linha: React.CSSProperties = { display: "flex", gap: 8, fontSize: 12.5, lineHeight: 1.45 };
const rot: React.CSSProperties = { color: "var(--pm-t3)", minWidth: 118, flex: "none" };

export function PainelCaso({ caso, causas, onFechar, onMudou }: { caso: CasoFila; causas: Causa[]; onFechar: () => void; onMudou: () => void }) {
  const { perfil } = usePerfil();
  const qc = useQueryClient();
  const quem = perfil?.nome ?? null;

  const detQ = useQuery({
    queryKey: ["devolucoes", "caso", caso.marketplace, caso.case_id],
    queryFn: () => lerCaso(caso.marketplace, caso.case_id),
    staleTime: 30_000, placeholderData: undefined, gcTime: 0,
  });
  const det = detQ.data;

  // --- bloco de resposta -----------------------------------------------------
  const [causa, setCausa] = useState<string>(caso.causa_interna ?? caso.causa_provavel ?? "");
  const [texto, setTexto] = useState("");
  const [sugUsada, setSugUsada] = useState<"nenhuma" | "historico" | "modelo">("nenhuma");
  const [acaoMl, setAcaoMl] = useState<AcaoResposta>(
    caso.acao_esperada === "responder_comprador" ? "mensagem_comprador" : caso.acao_esperada === "reembolsar" ? "reembolsar" : "mensagem_mediador",
  );
  const [agindo, setAgindo] = useState<string | null>(null);
  useEffect(() => { setCausa(caso.causa_interna ?? caso.causa_provavel ?? ""); setTexto(""); setSugUsada("nenhuma"); }, [caso.case_id, caso.causa_interna, caso.causa_provavel]);

  const sugQ = useQuery({
    queryKey: ["devolucoes", "sugestoes", caso.marketplace, caso.motivo_nome, causa, caso.case_id],
    queryFn: () => lerSugestoes({ marketplace: caso.marketplace, motivo: caso.motivo_nome ?? caso.motivo, causa: causa || null, acao: null, texto: caso.texto_cliente }),
    staleTime: 60_000,
  });

  // --- disputa (Shopee) -------------------------------------------------------
  const [disputando, setDisputando] = useState(false);
  const [dispMotivo, setDispMotivo] = useState("");
  const [dispEmail, setDispEmail] = useState(() => { try { return localStorage.getItem("devol_disputa_email") ?? ""; } catch { return ""; } });
  const [dispFotos, setDispFotos] = useState<File[]>([]);
  const motivosQ = useQuery({
    queryKey: ["devolucoes", "motivos_disputa", caso.case_id],
    enabled: disputando && caso.marketplace === "shopee",
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<MotivoDisputa[]> => {
      const d = await chamarShopee(`modulo=motivos-disputa&return_sn=${encodeURIComponent(caso.case_id)}`);
      return (d.motivos ?? []) as MotivoDisputa[];
    },
  });
  const motivos = motivosQ.data ?? [];
  const motivoSel = motivos.find((m) => String(m.dispute_reason) === dispMotivo) ?? motivos[0];
  const evidenciaObrigatoria = (motivoSel?.evidence_module_list ?? []).some((m) => m.is_required);

  const shopeeInfo = useMemo<InfoDevolucao | undefined>(() => {
    if (!det?.shopee) return undefined;
    const s = det.shopee as Record<string, unknown>;
    const p = (det.pedido ?? {}) as Record<string, unknown>;
    return {
      return_sn: caso.case_id, order_sn: caso.order_sn,
      status: s.status as string | null, solucao: s.solucao as number | null, due_date: s.due_date as string | null,
      prazo_disputa: s.prazo_disputa as string | null, compensacao_status: s.compensacao_status as string | null,
      needs_logistics: s.needs_logistics as boolean | null, logistica_reversa: s.logistica_reversa as string | null,
      volta_entregue_em: s.volta_entregue_em as string | null, prazo_vendedor: s.prazo_vendedor as string | null,
      tracking_number: s.tracking_number as string | null, itens: caso.itens,
      ida_status: s.ida_status as string | null, ida_entregue_em: s.ida_entregue_em as string | null, ida_falha_em: s.ida_falha_em as string | null,
      ida_devolvido_em: s.ida_devolvido_em as string | null, ida_ultimo_evento: s.ida_ultimo_evento as string | null,
      ida_ultimo_em: s.ida_ultimo_em as string | null, ida_consultado_em: (s.ida_ultimo_em as string | null) ?? null,
      opcao_envio: (p.opcao_envio as string | null) ?? null, status_pedido: (p.status_pedido as string | null) ?? null,
    };
  }, [det, caso]);

  const podeResponderShopee = caso.marketplace === "shopee" && ["responder", "validar_reembolso", "validar_produto"].includes(caso.acao_esperada);
  const causaObj = causas.find((c) => c.codigo === causa);
  const causasPorGrupo = useMemo(() => {
    const m = new Map<string, Causa[]>();
    for (const c of causas) m.set(c.grupo, [...(m.get(c.grupo) ?? []), c]);
    return [...m.entries()];
  }, [causas]);

  function exigeCausa(): boolean {
    if (causa) return true;
    toast.warning("Marque a causa interna antes de responder — é isso que alimenta a aba de erros.");
    return false;
  }

  async function depois(msg: string) {
    toast.success(msg);
    await qc.invalidateQueries({ queryKey: ["devolucoes"] });
    onMudou();
  }

  async function gravar(acao: AcaoResposta, extra: Partial<Parameters<typeof registrarResposta>[0]> = {}) {
    await registrarResposta({
      caso, acao, causa_interna: causa || null, respondido_por: quem, texto_resposta: texto.trim() || null, sugestao_usada: sugUsada,
      entrada_estado: det?.entrada?.itens?.find((i) => (i.estado ?? "ok") !== "ok")?.estado ?? null, ...extra,
    });
    if (det?.entrada?.id && causa && det.entrada.causa_interna !== causa) await marcarCausaNaEntrada(det.entrada.id, causa);
  }

  async function soCausa() {
    if (!exigeCausa()) return;
    setAgindo("causa");
    try { await gravar("so_causa"); await depois("Causa registrada."); }
    catch (e) { toast.error("Não gravou", { description: (e as Error).message }); }
    finally { setAgindo(null); }
  }

  async function aprovar() {
    if (!exigeCausa()) return;
    if (!window.confirm(`Finalizar SEM disputa e reembolsar o comprador?\n\nSolicitação ${caso.case_id} · pedido ${caso.order_sn}\nReembolso de ${brl(caso.valor)}. AÇÃO IRREVERSÍVEL.`)) return;
    setAgindo("aprovar");
    try {
      const r = await chamarShopee(`modulo=responder-reembolsar&return_sn=${encodeURIComponent(caso.case_id)}&confirmar=1`);
      await gravar("aprovar", { resposta_mkt: r, ok: true });
      await depois(`Reembolso aprovado — ${caso.case_id}`);
      onFechar();
    } catch (e) {
      const msg = (e as Error).message;
      toast.error("Falha ao aprovar", { description: /RETURN_ACCEPTED/.test(msg) ? "A Shopee já concluiu o reembolso desta solicitação." : msg });
    } finally { setAgindo(null); }
  }

  async function disputar() {
    if (!exigeCausa() || !motivoSel) return;
    const t = texto.trim();
    const email = dispEmail.trim();
    if (t.length < 10) return void toast.warning("Escreva a justificativa (mín. 10 caracteres).");
    if (!email.includes("@")) return void toast.warning("Informe um e-mail de contato válido.");
    if (evidenciaObrigatoria && dispFotos.length === 0) return void toast.warning("Este motivo EXIGE evidência — anexe ao menos 1 foto.");
    if (!window.confirm(`Abrir disputa na Shopee?\n\nSolicitação ${caso.case_id} · motivo ${motivoSel.dispute_reason}\nA Shopee vai julgar. AÇÃO IRREVERSÍVEL.`)) return;
    setAgindo("disputar");
    try {
      try { localStorage.setItem("devol_disputa_email", email); } catch { /* sem armazenamento */ }
      const urls: string[] = [];
      for (const f of dispFotos) {
        const b64 = await arquivoParaBase64(f);
        const r = await chamarShopee("modulo=converter-imagem", { return_sn: caso.case_id, imagem_base64: b64, mime: f.type || "image/jpeg" });
        if (r.url) urls.push(String(r.url));
      }
      const image_list = (motivoSel.evidence_module_list ?? [])
        .map((m) => ({ module_index: m.module_index, requirement: m.requirement, image_url: urls }))
        .filter((m) => m.image_url.length > 0);
      const enviado = { motivo: motivoSel.dispute_reason, email, texto: t, image_list };
      const r = await chamarShopee(`modulo=responder-disputar&return_sn=${encodeURIComponent(caso.case_id)}&confirmar=1`, enviado);
      await gravar("disputar", { motivo_disputa_id: String(motivoSel.dispute_reason), enviado, resposta_mkt: r, ok: true });
      await depois(`Disputa aberta — ${caso.case_id}`);
      setDisputando(false); setDispFotos([]);
      onFechar();
    } catch (e) {
      toast.error("Falha ao abrir disputa", { description: (e as Error).message });
    } finally { setAgindo(null); }
  }

  async function registrarMl() {
    if (!exigeCausa()) return;
    if (!texto.trim() && acaoMl !== "reembolsar") return void toast.warning("Cole aqui o que você respondeu no Mercado Livre.");
    setAgindo("ml");
    try { await gravar(acaoMl, { ok: null }); await depois("Resposta registrada no histórico."); }
    catch (e) { toast.error("Não gravou", { description: (e as Error).message }); }
    finally { setAgindo(null); }
  }

  async function guardarModelo() {
    const t = texto.trim();
    if (t.length < 10) return void toast.warning("Escreva o texto antes de salvar como modelo.");
    const nome = window.prompt("Nome do modelo:", `${motivoPt(caso.motivo_nome ?? caso.motivo)} · ${causaObj?.nome ?? ""}`.trim());
    if (!nome) return;
    try {
      await salvarModelo({ nome, marketplace: caso.marketplace, causa_interna: causa || null, acao: null, texto: t, criado_por: quem });
      toast.success("Modelo salvo.");
      void qc.invalidateQueries({ queryKey: ["devolucoes", "sugestoes"] });
    } catch (e) { toast.error("Não salvou", { description: (e as Error).message }); }
  }

  const ae = acaoEsperada(caso.acao_esperada);
  const pz = prazoTexto(caso.prazo);
  const link = linkMarketplace(caso);
  const fotosCliente = (det?.shopee?.images as string[] | null | undefined) ?? [];

  return (
    <>
      <div onClick={onFechar} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", zIndex: 60 }} />
      <aside
        className="pm-ui"
        style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(100vw, 560px)", background: "var(--pm-bg)", color: "var(--pm-t)", zIndex: 61, display: "flex", flexDirection: "column", boxShadow: "-8px 0 30px rgba(0,0,0,.25)", fontSize: 13 }}
      >
        {/* cabeçalho */}
        <header style={{ padding: "12px 16px", borderBottom: "1px solid var(--pm-b)", background: "var(--pm-s)", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <Selo tom={caso.marketplace === "shopee" ? "r" : "a"}>{caso.marketplace === "shopee" ? "Shopee" : "Mercado Livre"}</Selo>
              <Selo tom="n">{lojaDe(caso)}</Selo>
              <Selo tom={ae.tom}>{ae.rotulo}</Selo>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, marginTop: 6, fontFamily: "ui-monospace, monospace" }}>{caso.case_id}</div>
            <div style={{ fontSize: 12, color: "var(--pm-t2)" }}>
              pedido <b style={{ fontFamily: "ui-monospace, monospace" }}>{caso.order_sn ?? "—"}</b>
              {caso.tiny_numero && <> · Tiny <b>{caso.tiny_numero}</b>{caso.tiny_situacao ? ` (${caso.tiny_situacao})` : ""}</>}
              {link && <> · <a href={link} target="_blank" rel="noreferrer" style={{ color: "var(--pm-at)" }}>abrir no {caso.marketplace === "shopee" ? "Seller Center" : "ML"}</a></>}
            </div>
          </div>
          <div style={{ textAlign: "right", flex: "none" }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{brl(caso.valor)}</div>
            <div style={{ fontSize: 12, color: pz.tom === "r" ? "var(--pm-r)" : pz.tom === "a" ? "var(--pm-am)" : "var(--pm-t3)", fontWeight: 600 }}>
              {caso.prazo ? `prazo ${pz.txt} · ${diaHora(caso.prazo)}` : "sem prazo"}
            </div>
          </div>
          <button type="button" onClick={onFechar} aria-label="Fechar" style={{ border: 0, background: "transparent", fontSize: 20, cursor: "pointer", color: "var(--pm-t2)", lineHeight: 1 }}>×</button>
        </header>

        <div style={{ flex: 1, overflowY: "auto", padding: "4px 16px 24px" }}>
          {detQ.isLoading && <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 16, color: "var(--pm-t3)" }}><Spinner /> lendo o caso…</div>}
          {detQ.error && <div style={{ color: "var(--pm-r)", padding: 12 }}>{(detQ.error as Error).message}</div>}

          {/* o que o cliente diz */}
          {secao("O cliente diz")}
          <div style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 12, padding: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <b>{motivoPt(caso.motivo_nome ?? caso.motivo)}</b>
              <span style={{ color: "var(--pm-t3)", fontSize: 12 }}>{caso.solucao ? SOLUCAO_PT[caso.solucao] ?? caso.solucao : ""}</span>
              {det?.ml?.expected_resolution && <Selo tom="n">quer: {String(det.ml.expected_resolution).replace(/_/g, " ")}</Selo>}
            </div>
            {caso.texto_cliente && <p style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", fontStyle: "italic", color: "var(--pm-t2)" }}>"{caso.texto_cliente}"</p>}
            {fotosCliente.length > 0 && (
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                {fotosCliente.map((u) => (
                  <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="foto do cliente" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8, border: "1px solid var(--pm-b)" }} /></a>
                ))}
              </div>
            )}
          </div>

          {/* mensagens do ML */}
          {caso.marketplace === "mercadolivre" && (det?.mensagens?.length ?? 0) > 0 && (
            <>
              {secao("Conversa na reclamação")}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {det!.mensagens!.map((m) => {
                  const nos = m.de === "respondent";
                  return (
                    <div key={m.hash} style={{ alignSelf: nos ? "flex-end" : "flex-start", maxWidth: "92%", background: nos ? "var(--pm-as)" : "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 12, padding: "8px 10px" }}>
                      <div style={{ fontSize: 11, color: "var(--pm-t3)", marginBottom: 2 }}>
                        {m.de === "mediator" ? "Mediador do ML" : m.de === "complainant" ? "Comprador" : "Nós"} · {diaHora(m.data)}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap", fontSize: 12.5 }}>{m.texto}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* produto */}
          {secao("Produto")}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(det?.itens?.length ? det.itens : caso.itens.map((i) => ({ ...i, foto: caso.foto, preco: i.preco ?? null }))).map((i, k) => (
              <div key={`${i.sku}-${k}`} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <Foto src={i.foto ?? null} alt={i.nome ?? ""} tam={44} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.nome ?? "—"}</div>
                  <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>SKU {i.sku ?? "—"} · {i.qtd ?? 1} un{i.preco != null ? ` · ${brl(i.preco)}` : ""}</div>
                </div>
              </div>
            ))}
          </div>

          {/* situação */}
          {secao("Situação")}
          {caso.marketplace === "shopee" ? (
            <InfoDevolucaoCampos info={shopeeInfo} carregando={detQ.isLoading} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <div style={linha}><span style={rot}>Reclamação</span><span>{caso.status_mkt} · aberta em {dia(caso.criado_em)}</span></div>
              {caso.acoes.length > 0 && (
                <div style={linha}><span style={rot}>ML espera</span>
                  <span>{caso.acoes.map((a) => `${a.action.replace(/_/g, " ")}${a.mandatory ? " (obrigatória)" : ""}${a.due_date ? ` até ${diaHora(a.due_date)}` : ""}`).join(" · ")}</span>
                </div>
              )}
              {det?.ml?.resolucao != null && <div style={linha}><span style={rot}>Resolução</span><span>{JSON.stringify(det.ml.resolucao)}</span></div>}
              {(det?.envio_devolucao?.length ?? 0) > 0 && (
                <div style={linha}><span style={rot}>Envio de volta</span>
                  <span>{det!.envio_devolucao!.map((e) => `${e.shipment_id} · ${e.status ?? "?"}${e.tracking ? ` · ${e.tracking}` : ""}`).join(" / ")}</span>
                </div>
              )}
            </div>
          )}

          {/* galpão e Tiny */}
          {secao("Galpão e Tiny")}
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div style={linha}><span style={rot}>Entrada no galpão</span>
              <span>
                {det?.entrada ? <>{diaHora(det.entrada.recebido_em)} por {det.entrada.recebido_por ?? "?"}{det.entrada.conferido_ok === false ? " · com problema" : ""}</> : <span style={{ color: "var(--pm-t3)" }}>ainda não deu entrada</span>}
              </span>
            </div>
            {det?.entrada?.itens?.some((i) => (i.estado ?? "ok") !== "ok" || (i.qtd_recebida != null && i.qtd_esperada != null && i.qtd_recebida !== i.qtd_esperada)) && (
              <div style={linha}><span style={rot}>Conferência</span>
                <span>{det.entrada.itens.map((i) => `${i.sku}: ${ESTADO_ITEM_PT[i.estado ?? "ok"] ?? i.estado}${i.qtd_recebida != null && i.qtd_esperada != null && i.qtd_recebida !== i.qtd_esperada ? ` (${i.qtd_recebida}/${i.qtd_esperada})` : ""}${i.observacao ? ` — ${i.observacao}` : ""}`).join(" · ")}</span>
              </div>
            )}
            <div style={linha}><span style={rot}>Quem separou</span><span>{det?.separador ?? caso.separador ?? <span style={{ color: "var(--pm-t3)" }}>sem TAG finalizada</span>}</span></div>
            {det?.tiny && (
              <div style={linha}><span style={rot}>Tiny</span>
                <span>#{det.tiny.numero_pedido} · {det.tiny.situacao ?? "?"}{det.tiny.numero_nota_fiscal ? ` · NF ${det.tiny.numero_nota_fiscal}/${det.tiny.serie_nfe ?? ""}` : ""}{det.tiny.cliente_cidade ? ` · ${det.tiny.cliente_cidade}/${det.tiny.cliente_uf ?? ""}` : ""}{det.tiny.data_entrega ? ` · entregue ${dia(det.tiny.data_entrega)}` : ""}</span>
              </div>
            )}
            {det?.reembolso && (
              <div style={linha}><span style={rot}>Dinheiro</span>
                <span>{det.reembolso.classe ?? ""}{det.reembolso.valor_reembolsado != null ? ` · reembolsado ${brl(det.reembolso.valor_reembolsado)}` : ""}{det.reembolso.descontado_vendedor ? ` · descontado de nós ${brl(det.reembolso.descontado_vendedor)}` : ""}{det.reembolso.compensado ? ` · compensado ${brl(det.reembolso.compensado)}` : ""}{det.reembolso.cmv != null ? ` · CMV ${brl(det.reembolso.cmv)}` : ""}</span>
              </div>
            )}
            {(det?.outras_do_pedido?.length ?? 0) > 0 && (
              <div style={linha}><span style={rot}>Outras do pedido</span><span>{det!.outras_do_pedido!.map((o) => `${o.return_sn} (${o.status})`).join(", ")}</span></div>
            )}
          </div>

          {/* respostas anteriores */}
          {(det?.respostas?.length ?? 0) > 0 && (
            <>
              {secao("Já respondido")}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {det!.respostas.map((r) => (
                  <div key={r.id} style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 10, padding: "8px 10px", fontSize: 12.5 }}>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 11.5, color: "var(--pm-t3)" }}>
                      <Selo tom={r.ok === false ? "r" : "azul"}>{r.acao.replace(/_/g, " ")}</Selo>
                      <span>{diaHora(r.respondido_em)} · {r.respondido_por ?? "?"}</span>
                      {r.causa_interna && <span>· {causas.find((c) => c.codigo === r.causa_interna)?.nome ?? r.causa_interna}</span>}
                      {r.resultado && <Selo tom="g">{r.resultado.replace(/_/g, " ")}</Selo>}
                    </div>
                    {r.texto_resposta && <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>{r.texto_resposta}</div>}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* resposta */}
          {secao("Responder")}
          <div style={{ background: "var(--pm-s)", border: "1px solid var(--pm-bs)", borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <Campo rotulo="Causa interna (obrigatória)" dica={!caso.causa_interna && caso.causa_provavel && causa === caso.causa_provavel ? "sugerida pelo motivo do marketplace — confirme ou troque" : undefined}>
              <Escolha value={causa} onChange={(e) => setCausa(e.target.value)}>
                <option value="">Escolha…</option>
                {causasPorGrupo.map(([g, lista]) => (
                  <optgroup key={g} label={GRUPO_CAUSA_PT[g] ?? g}>
                    {lista.map((c) => <option key={c.codigo} value={c.codigo}>{c.nome}</option>)}
                  </optgroup>
                ))}
              </Escolha>
            </Campo>

            {/* sugestões */}
            {sugQ.data && (sugQ.data.historico.length > 0 || sugQ.data.modelos.length > 0) ? (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--pm-t2)", marginBottom: 4 }}>Você já respondeu assim em casos parecidos</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {sugQ.data.historico.slice(0, 3).map((h) => (
                    <button key={`h${h.id}`} type="button" className="pm-hv" onClick={() => { setTexto(h.texto_resposta); setSugUsada("historico"); }}
                      style={{ textAlign: "left", border: "1px solid var(--pm-bc)", borderRadius: 9, padding: "6px 9px", background: "var(--pm-s2)", cursor: "pointer", color: "var(--pm-t)", fontSize: 12.5 }}>
                      <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>{h.vezes}× · última {dia(h.ultima_em)}{h.acao ? ` · ${h.acao.replace(/_/g, " ")}` : ""}</div>
                      <div style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{h.texto_resposta}</div>
                    </button>
                  ))}
                  {sugQ.data.modelos.slice(0, 3).map((m) => (
                    <button key={`m${m.id}`} type="button" className="pm-hv" onClick={() => { setTexto(m.texto); setSugUsada("modelo"); void contarUsoModelo(m.id, m.usos); }}
                      style={{ textAlign: "left", border: "1px dashed var(--pm-bc)", borderRadius: 9, padding: "6px 9px", background: "transparent", cursor: "pointer", color: "var(--pm-t)", fontSize: 12.5 }}>
                      <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>modelo · {m.nome}</div>
                      <div style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{m.texto}</div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
                Sem resposta parecida no histórico ainda ({sugQ.data?.total_respostas ?? 0} gravadas). O sistema passa a sugerir à medida que você responde por aqui.
              </div>
            )}

            <Campo rotulo={caso.marketplace === "shopee" ? "Texto (usado na disputa; na aprovação fica só no histórico)" : "O que você respondeu no Mercado Livre"}>
              <textarea value={texto} onChange={(e) => { setTexto(e.target.value); if (sugUsada !== "nenhuma") setSugUsada("nenhuma"); }} rows={4}
                style={{ padding: 10, borderRadius: 9, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", fontSize: 13, resize: "vertical", fontFamily: "inherit" }} />
            </Campo>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Botao tom="fantasma" onClick={guardarModelo} disabled={!texto.trim()}>Salvar como modelo</Botao>
              <div style={{ flex: 1 }} />
              <Botao tom="secundario" onClick={soCausa} disabled={agindo !== null}>{agindo === "causa" ? <Spinner /> : null} Só marcar a causa</Botao>
            </div>

            {/* ações por marketplace */}
            {caso.marketplace === "shopee" ? (
              podeResponderShopee ? (
                <div style={{ borderTop: "1px solid var(--pm-b)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                  {!disputando ? (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <Botao tom="ok" onClick={aprovar} disabled={agindo !== null}>{agindo === "aprovar" ? <Spinner /> : null} Aprovar reembolso</Botao>
                      <Botao tom="perigo" onClick={() => setDisputando(true)} disabled={agindo !== null}>Recusar / Disputar…</Botao>
                    </div>
                  ) : (
                    <>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>Disputar na Shopee</div>
                      {motivosQ.isLoading ? <div style={{ color: "var(--pm-t3)", fontSize: 12 }}>lendo os motivos aceitos…</div>
                        : motivos.length === 0 ? (
                          <div style={{ color: "var(--pm-r)", fontSize: 12 }}>A Shopee não aceita contestação por API para esta solicitação (ex.: "não recebi" é decidido pelo rastreio). Use o Seller Center.</div>
                        ) : (
                          <>
                            <Campo rotulo="Motivo (lista da Shopee para este caso)">
                              <Escolha value={String(motivoSel?.dispute_reason ?? "")} onChange={(e) => setDispMotivo(e.target.value)}>
                                {motivos.map((m) => <option key={m.dispute_reason} value={m.dispute_reason}>{m.dispute_reason} · {m.dispute_requirement ?? "sem exigência"}</option>)}
                              </Escolha>
                            </Campo>
                            <Campo rotulo="E-mail de contato"><Entrada value={dispEmail} onChange={(e) => setDispEmail(e.target.value)} placeholder="voce@empresa.com" /></Campo>
                            <Campo rotulo={evidenciaObrigatoria ? "Fotos (OBRIGATÓRIO para este motivo)" : "Fotos (opcional)"}>
                              <input type="file" accept="image/*" multiple onChange={(e) => setDispFotos(Array.from(e.target.files ?? []))} />
                            </Campo>
                            <div style={{ display: "flex", gap: 8 }}>
                              <Botao tom="perigo" onClick={disputar} disabled={agindo !== null}>{agindo === "disputar" ? <Spinner /> : null} Abrir disputa</Botao>
                              <Botao tom="fantasma" onClick={() => setDisputando(false)}>Cancelar</Botao>
                            </div>
                          </>
                        )}
                    </>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 11.5, color: "var(--pm-t3)", borderTop: "1px solid var(--pm-b)", paddingTop: 8 }}>
                  Esta solicitação não aceita resposta agora ({ae.rotulo.toLowerCase()}). Dá para registrar a causa.
                </div>
              )
            ) : (
              <AcoesMl
                caso={caso} texto={texto} causa={causa} sugUsada={sugUsada} agindo={agindo} setAgindo={setAgindo}
                exigeCausa={exigeCausa} depois={depois} onFechar={onFechar} link={link}
                registrarManual={{ acaoMl, setAcaoMl, registrarMl }}
              />
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
