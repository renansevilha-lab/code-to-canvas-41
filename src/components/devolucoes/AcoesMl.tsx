// ============================================================================
// Ações do Mercado Livre no painel do caso (ml-devolucao-lookup v6, 29/out/2026).
// Os botões seguem o que o ML lista em `acoes_disponiveis` da reclamação; cada
// envio é UMA POST com confirmação, e a própria função grava o histórico
// (devolucao_resposta) — por isso aqui NÃO se chama registrarResposta depois.
// ============================================================================
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Botao, Campo, Escolha } from "@/components/producao/ui";
import { Spinner } from "@/components/separacao/ui/kit";
import { acaoMl, brl, ACAO_ML_PT, type AcaoResposta, type CasoFila, type ModuloMl, type RespostaAcaoMl } from "@/lib/devolucoes";

export function AcoesMl(p: {
  caso: CasoFila; texto: string; causa: string; sugUsada: string; agindo: string | null; setAgindo: (v: string | null) => void;
  exigeCausa: () => boolean; depois: (msg: string) => Promise<void>; onFechar: () => void; link: string | null;
  registrarManual: { acaoMl: AcaoResposta; setAcaoMl: (a: AcaoResposta) => void; registrarMl: () => Promise<void> };
}) {
  const { caso, texto, causa, agindo, setAgindo, exigeCausa, depois } = p;
  const acoes = caso.acoes.map((a) => a.action);
  const tem = (...a: string[]) => a.some((x) => acoes.includes(x));
  const [previa, setPrevia] = useState<RespostaAcaoMl | null>(null);
  const [pct, setPct] = useState<string>("");
  const [reason, setReason] = useState<string>("SRF3");
  const [manual, setManual] = useState(false);

  const podeMsgMediador = tem("send_message_to_mediator");
  const podeMsgComprador = tem("send_message_to_complainant", "recontact");
  const podeReembolso = tem("refund");
  const podeParcial = tem("allow_partial_refund");
  const podeDisputa = tem("open_dispute");
  const podeReview = tem("return_review_ok", "return_review_unified_ok", "return_review_fail", "return_review_unified_fail");
  const podeDevolucao = caso.solucao === "devolucao" && (caso.status_mkt ?? "").startsWith("opened") && !podeReview;

  // prévia (o que o ML aceita hoje: percentuais, return_id, motivos de falha) — só leitura
  useEffect(() => {
    let vivo = true;
    const modulo: ModuloMl | null = podeReview ? "claim-review" : podeParcial || podeReembolso ? "claim-reembolsar" : null;
    if (!modulo) { setPrevia(null); return; }
    acaoMl(modulo, { claim_id: caso.case_id, ok: true }).then((r) => { if (vivo) setPrevia(r); }).catch(() => { if (vivo) setPrevia(null); });
    return () => { vivo = false; };
  }, [caso.case_id, podeReview, podeParcial, podeReembolso]);

  async function executar(modulo: ModuloMl, body: Record<string, unknown>, rotulo: string, confirmacao: string) {
    if (!exigeCausa()) return;
    if (!window.confirm(confirmacao)) return;
    setAgindo(modulo);
    try {
      const r = await acaoMl(modulo, { ...body, claim_id: caso.case_id, causa: causa || null, texto: texto.trim() || null, sugestao: p.sugUsada, confirmar: true });
      if (!r.ok) throw new Error(r.erro ?? "o Mercado Livre recusou");
      await depois(`${rotulo} — reclamação ${caso.case_id}`);
      p.onFechar();
    } catch (e) {
      toast.error(`Falha: ${rotulo.toLowerCase()}`, { description: (e as Error).message });
    } finally { setAgindo(null); }
  }

  const btn = (chave: string) => (agindo === chave ? <Spinner /> : null);
  const ofertas = previa?.ofertas_parciais?.available_offers ?? [];
  const motivos = (previa?.motivos_falha ?? []).filter((m) => !["SRF2", "SRF4"].includes(m.id));
  const txt = texto.trim();

  return (
    <div style={{ borderTop: "1px solid var(--pm-b)", paddingTop: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
        O Mercado Livre aceita agora: {acoes.length ? acoes.map((a) => ACAO_ML_PT[a] ?? a.replace(/_/g, " ")).join(" · ") : "nenhuma ação (só acompanhar)"}.
        {p.link && <> <a href={p.link} target="_blank" rel="noreferrer" style={{ color: "var(--pm-at)" }}>Abrir no ML</a>.</>}
      </div>

      {(podeMsgMediador || podeMsgComprador) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {podeMsgMediador && (
            <Botao tom="primario" disabled={agindo !== null || txt.length < 3}
              onClick={() => executar("claim-mensagem", { receiver_role: "mediator" }, "Mensagem enviada ao mediador", `Enviar ao MEDIADOR do Mercado Livre?\n\n"${txt.slice(0, 300)}"`)}>
              {btn("claim-mensagem")} Enviar ao mediador
            </Botao>
          )}
          {podeMsgComprador && (
            <Botao tom="primario" disabled={agindo !== null || txt.length < 3}
              onClick={() => executar("claim-mensagem", { receiver_role: "complainant" }, "Mensagem enviada ao comprador", `Enviar ao COMPRADOR?\n\n"${txt.slice(0, 300)}"`)}>
              {btn("claim-mensagem")} Enviar ao comprador
            </Botao>
          )}
          {txt.length < 3 && <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>escreva o texto acima para enviar</span>}
        </div>
      )}

      {(podeReembolso || podeParcial || podeDevolucao || podeDisputa) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          {podeDevolucao && (
            <Botao tom="secundario" disabled={agindo !== null}
              onClick={() => executar("claim-devolucao", {}, "Devolução aceita", `Aceitar a DEVOLUÇÃO do produto?\n\nO ML gera a etiqueta para o comprador e o reembolso sai quando o pacote for postado/entregue.\nPedido ${caso.order_sn} · ${brl(caso.valor)}`)}>
              {btn("claim-devolucao")} Aceitar devolução do produto
            </Botao>
          )}
          {podeReembolso && (
            <Botao tom="ok" disabled={agindo !== null}
              onClick={() => executar("claim-reembolsar", {}, "Reembolso total feito", `REEMBOLSAR o comprador por inteiro?\n\nPedido ${caso.order_sn} · ${brl(caso.valor)}\nDINHEIRO SAI DA CONTA. Ação irreversível.`)}>
              {btn("claim-reembolsar")} Reembolsar {brl(caso.valor)}
            </Botao>
          )}
          {podeParcial && ofertas.length > 0 && (
            <>
              <Escolha value={pct} onChange={(e) => setPct(e.target.value)} style={{ width: 170 }}>
                <option value="">reembolso parcial…</option>
                {ofertas.map((o) => <option key={o.percentage} value={o.percentage}>{o.percentage}% · {brl(o.amount)}</option>)}
              </Escolha>
              <Botao tom="secundario" disabled={agindo !== null || !pct}
                onClick={() => executar("claim-reembolsar", { percentual: Number(pct) }, `Oferta de ${pct}% enviada`, `Oferecer reembolso PARCIAL de ${pct}% (${brl(ofertas.find((o) => String(o.percentage) === pct)?.amount ?? null)})?\n\nO comprador decide se aceita. Se recusar, pode pedir mediação.`)}>
                {btn("claim-reembolsar")} Oferecer parcial
              </Botao>
            </>
          )}
          {podeDisputa && (
            <Botao tom="perigo" disabled={agindo !== null}
              onClick={() => executar("claim-disputa", {}, "Mediação pedida", "Pedir a MEDIAÇÃO do Mercado Livre?\n\nA conversa com o comprador fecha e um representante do ML decide. Ação irreversível.")}>
              {btn("claim-disputa")} Pedir mediação
            </Botao>
          )}
        </div>
      )}

      {podeReview && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Produto devolvido — o que chegou?</div>
          {previa?.devolucao && (
            <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
              devolução {previa.devolucao.status} · dinheiro {previa.devolucao.status_money}
              {previa.devolucao.shipments?.[0]?.tracking_number ? ` · rastreio ${previa.devolucao.shipments[0].tracking_number}` : ""}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Botao tom="ok" disabled={agindo !== null || !previa?.return_id}
              onClick={() => executar("claim-review", { ok: true }, "Produto validado (ok)", `Confirmar que o produto devolvido chegou OK?\n\nO ML conclui a devolução a favor do comprador. Pedido ${caso.order_sn}.`)}>
              {btn("claim-review")} Chegou OK
            </Botao>
            <Escolha value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 260 }}>
              {motivos.length ? motivos.map((m) => <option key={m.id} value={m.id}>{m.detail}</option>) : (
                <>
                  <option value="SRF3">A devolução está incompleta</option>
                  <option value="SRF5">O produto não está no pacote</option>
                  <option value="SRF6">Outro defeito no produto</option>
                  <option value="SRF7">Ainda não chegou</option>
                </>
              )}
            </Escolha>
            <Botao tom="perigo" disabled={agindo !== null || !previa?.return_id || txt.length < 5}
              onClick={() => executar("claim-review", { ok: false, reason, message: txt }, "Problema reportado ao ML", `Reportar ao ML que o produto devolvido veio com problema (${reason})?\n\n"${txt.slice(0, 300)}"\n\nO ML analisa e pode cobrar evidências.`)}>
              {btn("claim-review")} Reportar problema
            </Botao>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>
            "Produto avariado" e "produto diferente" exigem foto — por enquanto esses dois vão pelo painel do ML. Para reportar, escreva o que aconteceu no texto acima.
          </div>
        </div>
      )}

      <button type="button" onClick={() => setManual((v) => !v)} style={{ alignSelf: "flex-start", border: 0, background: "transparent", color: "var(--pm-t3)", fontSize: 11.5, cursor: "pointer", padding: 0, textDecoration: "underline" }}>
        {manual ? "esconder" : "respondi pelo painel do ML — só registrar"}
      </button>
      {manual && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <Campo rotulo="O que foi feito lá">
            <Escolha value={p.registrarManual.acaoMl} onChange={(e) => p.registrarManual.setAcaoMl(e.target.value as AcaoResposta)} style={{ width: 240 }}>
              <option value="mensagem_mediador">Respondi ao mediador</option>
              <option value="mensagem_comprador">Respondi ao comprador</option>
              <option value="reembolsar">Reembolsei</option>
              <option value="validar_ok">Validei o produto devolvido (ok)</option>
              <option value="validar_recusa">Recusei o produto devolvido</option>
              <option value="disputar">Pedi mediação</option>
            </Escolha>
          </Campo>
          <Botao tom="secundario" onClick={p.registrarManual.registrarMl} disabled={agindo !== null}>{agindo === "ml" ? <Spinner /> : null} Registrar</Botao>
        </div>
      )}
    </div>
  );
}
