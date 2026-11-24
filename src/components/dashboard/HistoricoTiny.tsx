import { useMemo, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { L, int, pct } from "./formato";

// ============================================================================
// Dashboard › "Histórico de faturamento (Tiny)" (29/out/2026, pedido do dono).
// Só os TOTAIS por mês, lidos da listagem do Tiny pela edge fn tiny-vendas-historico
// (tabela tiny_vendas_dia → view_vendas_tiny_mensal). Desde 23/nov/2026 (dono: "puxar dados mais
// antigos", opção A) mostra TUDO o que o Tiny tem: a conta SVL desde jun/2022 e a conta Ottz desde
// jan/2025 (antes disso ela não existe neste Tiny). Os meses da Ottz antes de jul/2025 levam um aviso:
// são PEDIDOS — nessa época as notas da ACZ saíam por outro caminho, então não batem com o fiscal.
// Antes de 2025 a Ottz entra pela SHOPEE (edge fn shopee-vendas-historico → shopee_vendas_dia, valor dos
// produtos do pedido, que é o que casa com o Tiny): só a Shopee — o Mercado Livre só devolve 12 meses.
// NÃO é a mesma conta do "Desempenho do período": aqui é o valor do pedido no Tiny
// (com frete, sem taxas nem custo); lá é o integrado dos marketplaces. Cancelados à parte.
// Bloco recolhível; aberto/fechado fica no navegador.
// ============================================================================

interface Linha { mes: string; empresa: string; marketplace: string; canal: string; pedidos: number; valor: number; pedidos_cancelados: number; valor_cancelado: number }
interface Estado { fonte: string; lido: boolean; fora_do_plano: boolean; dia: string }

const MKTS: Array<{ id: string; nome: string }> = [
  { id: "shopee", nome: "Shopee" }, { id: "mercadolivre", nome: "Mercado Livre" }, { id: "amazon", nome: "Amazon" },
  { id: "tiktok", nome: "TikTok" }, { id: "outros", nome: "Outros" },
];
const grupoMkt = (m: string) => (MKTS.some((x) => x.id === m) ? m : "outros");
const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
/** competência "2025-03-01" → "mar/25" sem passar por Date (fuso) */
const rotulo = (m: string) => `${MES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const menos1Ano = (m: string) => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`;
const CHAVE = "dashboard.historicoTiny.aberto";
/** de quando a quando cada fonte é lida (os mesmos limites das edge fns tiny-vendas-historico e shopee-vendas-historico) */
const FONTES: Record<string, { de: string; ate?: string }> = { svl: { de: "2022-06-01" }, ottz: { de: "2025-01-01" }, "shopee-ottz": { de: "2020-01-01", ate: "2024-12-31" } };
const INICIO = "2020-01-01";
/** antes deste mês a Ottz não está no Tiny: os pedidos vêm direto da Shopee */
const OTTZ_NO_TINY = "2025-01-01";
/** antes deste mês os pedidos da conta Ottz não viravam nota da ACZ por este Tiny */
const OTTZ_COM_NOTA = "2025-07-01";

const th: CSSProperties = { textAlign: "right", fontWeight: 500, fontSize: 11, color: "var(--pm-t3)", padding: "6px 8px", whiteSpace: "nowrap", borderBottom: "1px solid var(--pm-b)" };
const td: CSSProperties = { textAlign: "right", padding: "6px 8px", whiteSpace: "nowrap", borderBottom: "1px solid var(--pm-b)" };

export function HistoricoTiny({ tick = 0 }: { tick?: number }) {
  const [aberto, setAberto] = useState<boolean>(() => { try { return localStorage.getItem(CHAVE) === "1"; } catch { return false; } });
  const [empresa, setEmpresa] = useState<"todas" | "ACZ Pet" | "SVL Store">("todas");
  const alternar = () => setAberto((a) => { try { localStorage.setItem(CHAVE, a ? "0" : "1"); } catch { /* sem storage */ } return !a; });

  const dadosQ = useQuery({
    queryKey: ["dashboard", "historico-tiny", tick], enabled: aberto, staleTime: 30 * 60_000,
    queryFn: async () => {
      // paginado: mês × empresa × canal passa de 1.000 linhas com o histórico inteiro
      const todas: Linha[] = [];
      for (let off = 0; off < 10000; off += 1000) {
        const { data, error } = await supabaseExternal.from("view_vendas_tiny_mensal" as never)
          .select("mes, empresa, marketplace, canal, pedidos, valor, pedidos_cancelados, valor_cancelado").gte("mes", INICIO)
          .order("mes").order("empresa").order("canal").range(off, off + 999);
        if (error) throw error;
        todas.push(...((data ?? []) as unknown as Linha[]));
        if (!data || data.length < 1000) break;
      }
      return todas;
    },
  });
  // andamento da busca: quantos dias já foram lidos e quantos ficaram fora do plano
  const estadoQ = useQuery({
    queryKey: ["dashboard", "historico-tiny-estado", tick], enabled: aberto, staleTime: 10 * 60_000,
    queryFn: async () => {
      const todos: Estado[] = [];
      for (let off = 0; off < 10000; off += 1000) {
        const { data, error } = await supabaseExternal.from("view_vendas_hist_estado" as never).select("fonte, dia, lido, fora_do_plano").gte("dia", INICIO).order("fonte").order("dia").range(off, off + 999);
        if (error) throw error;
        todos.push(...((data ?? []) as unknown as Estado[]));
        if (!data || data.length < 1000) break;
      }
      return todos;
    },
  });

  const meses = useMemo(() => {
    const m = new Map<string, { mes: string; pedidos: number; valor: number; canc: number; valorCanc: number; acz: number; mkt: Record<string, number> }>();
    for (const l of dadosQ.data ?? []) {
      if (empresa !== "todas" && l.empresa !== empresa) continue;
      const x = m.get(l.mes) ?? { mes: l.mes, pedidos: 0, valor: 0, canc: 0, valorCanc: 0, acz: 0, mkt: {} };
      x.pedidos += Number(l.pedidos); x.valor += Number(l.valor);
      if (l.empresa === "ACZ Pet") x.acz += Number(l.valor);
      x.canc += Number(l.pedidos_cancelados); x.valorCanc += Number(l.valor_cancelado);
      const g = grupoMkt(l.marketplace);
      x.mkt[g] = (x.mkt[g] ?? 0) + Number(l.valor);
      m.set(l.mes, x);
    }
    return [...m.values()].sort((a, b) => a.mes.localeCompare(b.mes));
  }, [dadosQ.data, empresa]);
  const porMes = useMemo(() => new Map(meses.map((x) => [x.mes, x])), [meses]);
  const maxValor = Math.max(1, ...meses.map((x) => x.valor));

  const est = estadoQ.data ?? [];
  const lidos = est.filter((e) => e.lido).length;
  const fora = est.filter((e) => e.fora_do_plano).length;
  const ultimoLido = est.filter((e) => e.lido).map((e) => e.dia).sort().at(-1) ?? null;
  // mês incompleto = algum dia dele ainda não foi lido em alguma conta (enquanto a busca anda)
  const incompletos = useMemo(() => {
    const lidosPorMes = new Map<string, Set<string>>();
    for (const e of est) if (e.lido || e.fora_do_plano) {
      const k = `${e.fonte}|${e.dia.slice(0, 7)}`; const s = lidosPorMes.get(k) ?? new Set<string>(); s.add(e.dia); lidosPorMes.set(k, s);
    }
    const out = new Set<string>();
    const ontem = new Date(Date.now() - 27 * 3600_000).toISOString().slice(0, 10);
    for (const x of meses) {
      const ano = Number(x.mes.slice(0, 4)), mm = Number(x.mes.slice(5, 7));
      const diasNoMes = new Date(Date.UTC(ano, mm, 0)).getUTCDate();
      const ate = x.mes.slice(0, 7) === ontem.slice(0, 7) ? Number(ontem.slice(8, 10)) : diasNoMes;
      for (const [c, lim] of Object.entries(FONTES)) {
        const ym = x.mes.slice(0, 7);
        if (ym < lim.de.slice(0, 7) || (lim.ate && ym > lim.ate.slice(0, 7))) continue;   // a fonte não cobre este mês
        const desde = ym === lim.de.slice(0, 7) ? Number(lim.de.slice(8, 10)) : 1;
        if ((lidosPorMes.get(`${c}|${ym}`)?.size ?? 0) < ate - desde + 1) out.add(x.mes);
      }
    }
    return out;
  }, [est, meses]);

  const seg = (id: typeof empresa, nome: string) => (
    <button key={id} type="button" onClick={() => setEmpresa(id)} className="pm-hv"
      style={{ fontSize: 12, padding: "3px 10px", borderRadius: 6, cursor: "pointer", border: "1px solid var(--pm-bc)", background: empresa === id ? "var(--pm-a)" : "var(--pm-s)", color: empresa === id ? "#fff" : "var(--pm-t)" }}>{nome}</button>
  );

  return (
    <section className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 12, padding: 14, borderRadius: 18, background: "var(--pm-s2)", border: "1px solid var(--pm-b)", color: "var(--pm-t)", fontSize: 13 }}>
      <button type="button" onClick={alternar} style={{ all: "unset", cursor: "pointer", display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "6px 12px" }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{aberto ? "▾" : "▸"} Histórico de faturamento (Tiny e Shopee)</h2>
        <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>mês a mês desde {meses.length ? rotulo(meses[0].mes) : "o primeiro pedido no Tiny"} · valor do pedido, sem taxas nem custo · cancelados à parte</span>
      </button>

      {aberto && (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            {seg("todas", "Ambas")}{seg("ACZ Pet", "ACZ Pet")}{seg("SVL Store", "SVL Store")}
            <span style={{ fontSize: 12, color: "var(--pm-t3)", marginLeft: "auto" }}>
              {estadoQ.isLoading ? "…" : `${int(lidos)} dias lidos${ultimoLido ? ` (até ${ultimoLido.slice(8, 10)}/${ultimoLido.slice(5, 7)}/${ultimoLido.slice(2, 4)})` : ""}${fora ? ` · ${int(fora)} fora do plano do Tiny` : ""}${incompletos.size ? ` · busca em andamento: ${incompletos.size} ${incompletos.size === 1 ? "mês incompleto" : "meses incompletos"}` : ""}`}
            </span>
          </div>

          {dadosQ.error ? (
            <div style={{ color: "var(--pm-r)" }}>Não consegui ler o histórico: {(dadosQ.error as Error).message}</div>
          ) : dadosQ.isLoading ? (
            <div style={{ height: 160, borderRadius: 10, background: "var(--pm-sk)" }} />
          ) : meses.length === 0 ? (
            <div style={{ color: "var(--pm-t3)" }}>Ainda sem dados — a busca no Tiny está rodando (a SVL durante o dia, a Ottz de madrugada).</div>
          ) : (
            <>
              {/* barras do faturamento mensal */}
              <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 150, padding: "4px 2px 0", overflowX: "auto" }}>
                {meses.map((x) => (
                  <div key={x.mes} title={`${rotulo(x.mes)}: ${L(x.valor)} · ${int(x.pedidos)} pedidos${incompletos.has(x.mes) ? " (incompleto)" : ""}`}
                    style={{ flex: "1 0 22px", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, height: "100%", justifyContent: "flex-end" }}>
                    <div style={{ width: "100%", maxWidth: 34, height: `${Math.max(2, (x.valor / maxValor) * 118)}px`, borderRadius: "4px 4px 0 0", background: "var(--pm-a)", opacity: incompletos.has(x.mes) ? 0.4 : 1 }} />
                    <span style={{ fontSize: 10, color: "var(--pm-t3)" }}>{rotulo(x.mes)}</span>
                  </div>
                ))}
              </div>

              <div style={{ overflowX: "auto", background: "var(--pm-s)", border: "1px solid var(--pm-b)", borderRadius: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ ...th, textAlign: "left" }}>Mês</th>
                      <th style={th}>Pedidos</th>
                      <th style={th}>Faturamento</th>
                      <th style={th}>vs mês anterior</th>
                      <th style={th}>vs ano anterior</th>
                      {MKTS.map((m) => <th key={m.id} style={th}>{m.nome}</th>)}
                      <th style={th}>Cancelado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...meses].reverse().map((x, i, arr) => {
                      const ant = arr[i + 1];
                      const aa = porMes.get(menos1Ano(x.mes));
                      const delta = (base?: { valor: number }) => {
                        if (!base || base.valor <= 0) return <span style={{ color: "var(--pm-t3)" }}>—</span>;
                        const d = (x.valor / base.valor - 1) * 100;
                        return <span style={{ color: d >= 0 ? "var(--pm-g)" : "var(--pm-r)" }}>{d >= 0 ? "+" : ""}{pct(d)}</span>;
                      };
                      const inc = incompletos.has(x.mes);
                      const soShopee = x.mes < OTTZ_NO_TINY && x.acz > 0;
                      const soPedido = !soShopee && x.mes < OTTZ_COM_NOTA && x.acz > 0;
                      return (
                        <tr key={x.mes} className="pm-linha-hv">
                          <td style={{ ...td, textAlign: "left", fontWeight: 500 }}>{rotulo(x.mes)}{inc && <span style={{ marginLeft: 6, fontSize: 10, color: "var(--pm-t3)" }}>incompleto</span>}{soPedido && <span title="Pedidos da conta Ottz no Tiny. Nessa época as notas da ACZ saíam por outro caminho: o valor não bate com o fiscal." style={{ marginLeft: 6, fontSize: 10, color: "var(--pm-am)" }}>pedidos, sem nota ¹</span>}{soShopee && <span title="A Ottz só está no Tiny desde jan/2025. Antes disso o valor vem direto da Shopee (loja Ottz) e não inclui o Mercado Livre." style={{ marginLeft: 6, fontSize: 10, color: "var(--pm-am)" }}>Ottz só Shopee ²</span>}</td>
                          <td style={td}>{int(x.pedidos)}</td>
                          <td style={{ ...td, fontWeight: 600 }}>{L(x.valor)}</td>
                          <td style={td}>{inc ? "—" : delta(ant)}</td>
                          <td style={td}>{inc ? "—" : delta(aa)}</td>
                          {MKTS.map((m) => <td key={m.id} style={{ ...td, color: x.mkt[m.id] ? "var(--pm-t)" : "var(--pm-t3)" }}>{x.mkt[m.id] ? L(x.mkt[m.id]) : "—"}</td>)}
                          <td style={{ ...td, color: "var(--pm-t2)" }}>{x.canc ? `${L(x.valorCanc)} · ${int(x.canc)}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>
                Fonte: listagem de pedidos do Tiny (conta SVL desde jun/2022, conta Ottz desde jan/2025). Na conta SVL fica de fora o pedido sem canal, que desde jun/2026 é a cópia fiscal dos pedidos da Bumi que já estão na conta Ottz.
                "Outros" = Temu/Olist, Shein, venda direta e pedidos sem canal.
                {meses.some((x) => x.mes < OTTZ_COM_NOTA && x.mes >= OTTZ_NO_TINY && x.acz > 0) && " ¹ De jan a jun/2025 os pedidos da conta Ottz não viravam nota da ACZ por este Tiny: são pedidos, não faturamento fiscal."}
                {meses.some((x) => x.mes < OTTZ_NO_TINY && x.acz > 0) && " ² Antes de 2025 a Ottz não está no Tiny: o valor é o dos produtos dos pedidos lidos direto da Shopee (loja Ottz). Não inclui o Mercado Livre, que só devolve os últimos 12 meses."}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
