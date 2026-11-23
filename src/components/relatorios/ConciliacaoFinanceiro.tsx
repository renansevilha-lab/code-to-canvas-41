import { arr, brl, brlMil, ddmm, nomeCurto, num, obj, Pill, Secao, str } from "./comum";

// ============================================================================
// Conciliação do agente financeiro (resumo.conciliacao = financeiro_conciliacao(7);
// docs/financeiro-conciliacao.sql). Últimos 7 dias FECHADOS: extrato do Mercado
// Pago × carteira, repasse da Shopee por pedido, nota do fornecedor × ordem ×
// conta a pagar, devoluções e previsto × realizado. Só apresentação.
// ============================================================================

type Tom = "red" | "amber" | "green" | "gray";
function Bloco({ titulo, selo, tom, children }: { titulo: string; selo: string; tom: Tom; children: React.ReactNode }) {
  return (
    <div className="border border-(--rl-border) rounded-lg px-3.5 py-3 flex flex-col gap-1.5 min-w-0">
      <div className="flex gap-2 items-center justify-between flex-wrap">
        <span className="text-[13.5px] font-semibold">{titulo}</span>
        <Pill cor={tom}>{selo}</Pill>
      </div>
      <div className="flex flex-col gap-1 text-[13px] leading-[1.45] text-(--rl-text-2) [text-wrap:pretty]">{children}</div>
    </div>
  );
}
const nv = (x: unknown) => { const o = obj(x); return { n: num(o.n), valor: num(o.valor) }; };
const erro = (b: Record<string, unknown>) => (b.erro ? <div>Não foi possível calcular este bloco hoje.</div> : null);

export function ConciliacaoFinanceiro({ c, mobile }: { c: Record<string, unknown>; mobile?: boolean }) {
  if (!c.versao) return null;
  const jan = obj(c.janela);
  const mp = obj(c.mercado_pago); const mpR = obj(mp.resumo);
  const sh = obj(c.shopee);
  const fo = obj(c.fornecedor);
  const dv = obj(c.devolucoes);
  const fx = obj(c.fluxo); const fxA = obj(fx.acumulado);
  const cp = obj(c.contas_pagas);

  const invert = obj(mpR.saida_lancada_como_entrada);
  const semPar = nv(mpR.sem_par);
  const semContas = obj(fo.sem_contas); const semContas500 = nv(semContas.acima_de_500);
  const acima = nv(obj(fo.diferenca_ordem).notas_acima_da_ordem);
  const naoVoltou = obj(dv.produto_nao_voltou);
  const nfDev = obj(dv.nota_de_devolucao);
  const lojas = arr(sh.lojas);
  const abaixo = lojas.reduce<{ n: number; valor: number }>((s, l) => ({ n: s.n + nv(l.repasse_abaixo).n, valor: s.valor + nv(l.repasse_abaixo).valor }), { n: 0, valor: 0 });
  const semDataPg = nv(cp.sem_data_pagamento);

  return (
    <Secao titulo="Conciliação" nota={`${ddmm(str(jan.de))} a ${ddmm(str(jan.ate))} · ${num(obj(c.resumo).itens)} itens em aberto, ${brlMil(obj(c.resumo).valor_em_aberto)}`}>
      <div className={mobile ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 lg:grid-cols-2 gap-3"}>
        <Bloco titulo="Mercado Pago: extrato × carteira"
          selo={mp.erro ? "sem dado" : `fecha em ${num(mpR.dias_que_fecham)} de ${num(mpR.dias)} dias`}
          tom={mp.erro ? "gray" : num(mpR.dias_que_fecham) === num(mpR.dias) ? "green" : num(invert.n) > 0 ? "red" : "amber"}>
          {erro(mp)}
          {arr(mp.contas).map((k) => (
            <div key={str(k.conta)}>{str(k.conta)}: saldo de {brl(k.saldo)} ao fim de {ddmm(str(k.ultimo_dia))}.</div>
          ))}
          {!mp.erro && <div>{num(mpR.pares_ok)} lançamentos batem; {semPar.n} sem par ou com valor diferente ({brl(semPar.valor)}).</div>}
          {num(invert.n) > 0 && (
            <div style={{ color: "var(--rl-red)" }}>
              {num(invert.n)} pagamentos FEITOS pela conta estão na carteira como entrada ({brl(invert.valor)}): a carteira e o realizado do fluxo ficam {brl(invert.erro_na_carteira)} acima do extrato.
            </div>
          )}
          {num(mpR.dias_saldo_nao_confere) > 0 && <div style={{ color: "var(--rl-red)" }}>O saldo não fecha em {num(mpR.dias_saldo_nao_confere)} dia(s).</div>}
        </Bloco>

        <Bloco titulo="Shopee: repasse por pedido"
          selo={sh.erro ? "sem dado" : abaixo.n > 0 ? `${abaixo.n} abaixo do esperado` : "confere"} tom={sh.erro ? "gray" : abaixo.n > 0 ? "amber" : "green"}>
          {erro(sh)}
          {lojas.map((l) => {
            const ab = nv(l.repasse_abaixo); const sc = obj(l.sem_credito_30_a_60_dias);
            return (
              <div key={str(l.loja)}>
                {str(l.loja)}: {num(l.conciliados)} de {num(l.pedidos_creditados)} pedidos conferem ({brl(l.recebido)} recebidos de {brl(l.esperado)})
                {ab.n > 0 ? `; ${ab.n} com repasse menor (${brl(ab.valor)})` : ""}
                {num(sc.n) > 0 ? `; ${num(sc.n)} pedidos de 30 a 60 dias sem crédito (${brl(sc.valor)}${num(sc.resgate_acelera_60d) > 0 ? ", provavelmente pagos pelo resgate do Acelera" : ""})` : ""}.
              </div>
            );
          })}
        </Bloco>

        <Bloco titulo="Fornecedor: nota × ordem × conta a pagar"
          selo={fo.erro ? "sem dado" : semContas500.n > 0 ? `${semContas500.n} notas sem conta` : "confere"} tom={fo.erro ? "gray" : semContas500.n > 0 ? "red" : acima.n > 0 ? "amber" : "green"}>
          {erro(fo)}
          {semContas500.n > 0 && (
            <div>
              {semContas500.n} notas acima de R$ 500 sem conta a pagar que cite a nota ({brl(semContas500.valor)}):{" "}
              {arr(semContas.maiores).slice(0, 4).map((m) => `${nomeCurto(m.fornecedor)} nota ${str(m.nota)} (${brlMil(m.valor)})`).join(", ")}.
              Pode ser pagamento à vista sem lançamento ou boleto em nome do banco.
            </div>
          )}
          {acima.n > 0 && <div>{acima.n} ordens em que as notas somam mais que o pedido ({brl(acima.valor)} acima).</div>}
          {!fo.erro && semContas500.n === 0 && acima.n === 0 && <div>Notas dos últimos 60 dias com ordem e conta a pagar.</div>}
        </Bloco>

        <Bloco titulo="Devoluções e reembolsos"
          selo={dv.erro ? "sem dado" : `${brlMil(obj(dv.shopee_30_dias).saiu_do_bolso)} em 30 dias`} tom={dv.erro ? "gray" : num(naoVoltou.n) > 0 ? "amber" : "gray"}>
          {erro(dv)}
          {!dv.erro && (
            <div>
              Shopee, 30 dias: {num(obj(dv.shopee_30_dias).casos)} casos, {brl(obj(dv.shopee_30_dias).reembolsado)} reembolsados, {brl(obj(dv.shopee_30_dias).compensado_pela_shopee)} compensados pela Shopee.
            </div>
          )}
          {num(naoVoltou.n) > 0 && <div>{num(naoVoltou.n)} produtos não deram entrada no galpão há mais de 15 dias ({brl(naoVoltou.custo_do_produto)} a custo).</div>}
          {num(obj(nfDev.svl_aguardando_emissao).n) > 0 && (
            <div>Nota de devolução da SVL: {num(obj(nfDev.svl_aguardando_emissao).n)} aguardando emissão{num(obj(nfDev.svl_rejeitadas).n) > 0 ? ` e ${num(obj(nfDev.svl_rejeitadas).n)} rejeitadas` : ""}.</div>
          )}
          {num(obj(nfDev.ottz_cancelados_com_nota_sem_devolucao).n) > 0 && (
            <div>Ottz: {num(obj(nfDev.ottz_cancelados_com_nota_sem_devolucao).n)} cancelados com nota de venda e sem devolução ({brl(obj(nfDev.ottz_cancelados_com_nota_sem_devolucao).valor)}).</div>
          )}
        </Bloco>

        <Bloco titulo="Fluxo de caixa: previsto × realizado"
          selo={fx.erro || fx.indisponivel ? "sem dado" : `${num(fxA.desvio_pct) > 0 ? "+" : ""}${num(fxA.desvio_pct).toLocaleString("pt-BR", { maximumFractionDigits: 0 })}%`}
          tom={fx.erro || fx.indisponivel ? "gray" : Math.abs(num(fxA.desvio_pct)) > 25 ? "amber" : "green"}>
          {erro(fx)}
          {fx.indisponivel ? <div>{str(fx.indisponivel)}</div> : null}
          {!fx.erro && !fx.indisponivel && <div>Previsto {brl(fxA.previsto)} × realizado {brl(fxA.realizado)} nos {num(fxA.dias)} dias.</div>}
          {fx.saidas_do_mercado_pago_contadas_como_entrada ? (
            <div>Parte da diferença é o erro da carteira do Mercado Pago ({brl(obj(fx.saidas_do_mercado_pago_contadas_como_entrada).erro_na_carteira)}).</div>
          ) : null}
        </Bloco>

        <Bloco titulo="Contas pagas" selo={cp.erro ? "sem dado" : semDataPg.n > 0 ? "cadastro incompleto" : "ok"} tom={cp.erro ? "gray" : "gray"}>
          {erro(cp)}
          {!cp.erro && <div>{num(obj(cp.pagas_na_janela).n)} contas pagas no período ({brl(obj(cp.pagas_na_janela).valor)}).</div>}
          {semDataPg.n > 0 && <div>{semDataPg.n.toLocaleString("pt-BR")} contas pagas sem data de pagamento no espelho; nenhuma tem conta bancária registrada, então ainda não dá para conferir com o banco.</div>}
        </Bloco>
      </div>
    </Secao>
  );
}
