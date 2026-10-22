import { type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabaseExternal } from "@/integrations/supabase/external-client";
import { useSincronizar } from "@/components/BotaoSincronizar";
import { LOGO, ddmm, idade, int } from "@/components/dashboard/formato";

// ============================================================================
// Fulfillment › topo da aba no design novo (Claude Design "Fulfillment", 22/out/2026):
// título + de quando são os dados dos CDs + Sincronizar, filtro global de empresa e marketplace
// (vale para as quatro abas), faixa "Pede ação" e as abas com contador. Tudo vem pronto da
// função fulfillment_painel(p_emp, p_mkt) — cada parte falha sozinha ({"erro"}).
// Cores = tokens --pm-* (.pm-ui em styles.css).
// ============================================================================

export type EmpF = "todas" | "ACZ Pet" | "SVL Store";
export type MktF = "todos" | "amazon" | "mercadolivre" | "shopee";
export type AbaF = "envios" | "reposicao" | "inventario" | "tarefas";
export type Destino = { aba: AbaF; destaque?: string | null };

type Erro = { erro: string };
interface Conta {
  shop_id: string; empresa: string; marketplace: string; nome: string; anuncios: number; inutil: number;
  atualizado_em: string | null; com_sugestao: number; un_sugeridas: number; zerados: number; no_filtro: boolean;
}
interface Painel {
  gerado_em: string;
  contas: Conta[] | Erro;
  envios: {
    abertos: number; un_abertas: number; enviados_30d: number;
    coleta: Array<{ id: string; numero: string | null; marketplace: string; empresa: string; status: string; data: string }>;
    sem_tiny: Array<{ id: string; numero: string | null; marketplace: string; empresa: string; sep: number }>;
  } | Erro;
  planos: Array<{ id: string; empresa: string; passo: string; criado_em: string; erro: string | null; tipo: "erro" | "parado" }> | Erro;
  zerados: { total: number; a_caminho: number; und_dia: number; top: Array<{ sku: string; produto: string; marketplace: string; empresa: string; und_dia: number }> } | Erro;
  tarefas: { abertas: number; atrasadas: Array<{ id: string; titulo: string; responsavel: string | null; prazo: string }> } | Erro;
}

const temErro = (x: unknown): x is Erro => !!x && typeof x === "object" && !Array.isArray(x) && "erro" in (x as object);
export const NOME_EMP: Record<string, string> = { "ACZ Pet": "Ottz Pet", "SVL Store": "Bumi Pet" };
const MKT_NOME: Record<string, string> = { amazon: "Amazon", mercadolivre: "Mercado Livre", shopee: "Shopee" };
/** "Amazon ACZ", "Mercado Livre SVL", "Shopee Ottz", "Shopee Bumi" */
export function nomeConta(mkt: string, empresa: string | null | undefined): string {
  const svl = empresa === "SVL Store";
  if (mkt === "shopee") return svl ? "Shopee Bumi" : "Shopee Ottz";
  return `${MKT_NOME[mkt] ?? mkt} ${svl ? "SVL" : "ACZ"}`;
}
const ETAPA: Record<string, string> = { separando: "separando", embalar: "embalar", etiquetas: "etiquetas", pronto_envio: "pronto para envio", enviado: "enviado" };
const SEV: Record<string, string> = { r: "var(--pm-r)", a: "var(--pm-am)", n: "var(--pm-t2)" };

const seg = (on: boolean): CSSProperties => ({
  border: 0, cursor: "pointer", height: 28, padding: "0 11px", borderRadius: 6, fontSize: 12.5, fontWeight: on ? 600 : 500,
  background: on ? "var(--pm-a)" : "transparent", color: on ? "var(--pm-oa)" : "var(--pm-t2)", boxShadow: on ? "var(--pm-sh)" : "none",
  display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap",
});
const segGrupo: CSSProperties = { display: "flex", gap: 2, padding: 2, background: "var(--pm-s2)", borderRadius: 8, flexWrap: "wrap" };
const logoMini = (mkt: string, px = 15): CSSProperties => ({
  display: "inline-block", width: px, height: px, borderRadius: 3, flex: "none",
  background: `#fff url(${LOGO[mkt] ?? LOGO.shopee}) center/contain no-repeat`,
});

/** "Dados dos CDs de hoje 08h05 · há 2 h" / "… de 20/10 08h05 · há 1 dia" */
function rotuloCds(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).replace(":", "h");
  const dia = d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const min = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  const ha = min < 1 ? "agora" : min < 60 ? `há ${min} min` : min < 24 * 60 ? `há ${Math.round(min / 60)} h` : `há ${Math.floor(min / 1440)} ${Math.floor(min / 1440) === 1 ? "dia" : "dias"}`;
  return `Dados dos CDs de ${dia === hoje ? "hoje" : ddmm(dia)} ${hm} · ${ha}`;
}

export function usePainelFulfillment(emp: EmpF, mkt: MktF) {
  return useQuery({
    queryKey: ["fulfillment", "painel", emp, mkt],
    queryFn: async () => {
      const { data, error } = await supabaseExternal.rpc("fulfillment_painel" as never, {
        p_emp: emp === "todas" ? null : emp, p_mkt: mkt === "todos" ? null : mkt,
      } as never);
      if (error) throw error;
      return data as unknown as Painel;
    },
    staleTime: 60_000,
    placeholderData: (a) => a,
  });
}

export const ROTAS_SYNC = [
  "fulfillment-sync?modulo=amazon",
  "fulfillment-sync?modulo=shopee&loja=ottz",
  "fulfillment-sync?modulo=shopee&loja=svl",
  "fulfillment-sync?modulo=ml&limite=120",
];

export function CabecalhoFulfillment({ emp, mkt, aba, onEmp, onMkt, onAba, onIr, busca }: {
  emp: EmpF; mkt: MktF; aba: AbaF;
  onEmp: (e: EmpF) => void; onMkt: (m: MktF) => void; onAba: (a: AbaF) => void; onIr: (d: Destino) => void;
  /** campo de busca das abas que ainda são da tela antiga (Reposição/Inventário) */
  busca?: ReactNode;
}) {
  const painelQ = usePainelFulfillment(emp, mkt);
  const { rodando, sincronizar } = useSincronizar({ rotas: ROTAS_SYNC, invalidar: ["fulfillment"] });
  const p = painelQ.data;
  const contas = p && !temErro(p.contas) ? p.contas : [];
  const noFiltro = contas.filter((c) => c.no_filtro);

  // de quando são os dados dos CDs: a leitura MAIS VELHA entre as contas do filtro (o pior caso)
  const leituras = noFiltro.map((c) => c.atualizado_em).filter(Boolean) as string[];
  const maisVelha = leituras.length ? leituras.reduce((a, b) => (a < b ? a : b)) : null;
  const q = idade(maisVelha);
  const fresh = rodando
    ? { t: "Sincronizando os CDs… leva cerca de 1 min", cor: "var(--pm-t2)", fw: 500, alerta: false }
    : maisVelha
      ? { t: rotuloCds(maisVelha), cor: q.velho ? "var(--pm-am)" : "var(--pm-t2)", fw: q.velho ? 600 : 500, alerta: q.velho }
      : { t: painelQ.isLoading ? "Lendo os CDs…" : "Sem leitura dos CDs", cor: "var(--pm-t3)", fw: 500, alerta: false };

  // ---------------- faixa "Pede ação"
  type Item = { id: string; sev: "r" | "a" | "n"; n: string; label: string; ctx: string; link: string; destino: Destino };
  const itens: Item[] = [];
  const emDia: string[] = [];
  const naoConferido: string[] = [];
  if (p) {
    if (temErro(p.envios)) naoConferido.push("envios");
    else {
      const c = p.envios.coleta;
      const hoje = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
      if (c.length) {
        const vencida = c.some((e) => e.data < hoje);
        itens.push({
          id: "coleta", sev: "r", n: String(c.length),
          label: vencida ? (c.length > 1 ? "Coletas vencidas, ainda não enviadas" : "Coleta vencida, ainda não enviado") : c.length > 1 ? "Coletas hoje, ainda não enviadas" : "Coleta hoje, ainda não enviado",
          ctx: c.slice(0, 3).map((e) => `${e.numero ?? "(s/ nº)"} · ${nomeConta(e.marketplace, e.empresa)} · ${ETAPA[e.status] ?? e.status}${e.data < hoje ? ` · era ${ddmm(e.data)}` : ""}`).join(" · "),
          link: "Ver no quadro", destino: { aba: "envios", destaque: c[0].id },
        });
      } else emDia.push("nenhuma coleta vencida");
      const s = p.envios.sem_tiny;
      if (s.length) {
        itens.push({
          id: "sem_tiny", sev: "r", n: String(s.length), label: "Enviado sem estoque no Tiny",
          ctx: `${s.slice(0, 3).map((e) => e.numero ?? "(s/ nº)").join(", ")}${s.length > 3 ? ` e mais ${s.length - 3}` : ""} · o Tiny segue vendendo o que já saiu`,
          link: "Lançar agora", destino: { aba: "envios", destaque: s[0].id },
        });
      } else emDia.push("estoque dos enviados lançado no Tiny");
    }
    if (temErro(p.planos)) naoConferido.push("planos da Amazon");
    else if (p.planos.length) {
      const pl = p.planos[0];
      const erro = pl.tipo === "erro";
      itens.push({
        id: "plano", sev: erro ? "r" : "a", n: String(p.planos.length),
        label: erro ? "Plano da Amazon com erro" : "Plano da Amazon parado no meio",
        ctx: `${pl.empresa === "SVL Store" ? "SVL" : "ACZ"} · ${ddmm(pl.criado_em.slice(0, 10))}${erro && pl.erro ? ` · “${pl.erro.replace(/^criar plano: /, "").slice(0, 90)}”` : ` · parado em ${pl.passo.replace(/_/g, " ")}`}`,
        link: "Abrir na Reposição", destino: { aba: "reposicao" },
      });
    } else if (mkt === "todos" || mkt === "amazon") emDia.push("planos da Amazon sem erro");
    if (temErro(p.zerados)) naoConferido.push("zerados no CD");
    else if (p.zerados.total) {
      const t = p.zerados.top[0];
      itens.push({
        id: "zerados", sev: "r", n: String(p.zerados.total), label: "Zerados no CD que vendem",
        ctx: `${t ? `maior: ${t.produto.split(/\s+/).slice(0, 5).join(" ")}, ${String(t.und_dia).replace(".", ",")} un/dia na ${nomeConta(t.marketplace, t.empresa)}` : ""}${p.zerados.a_caminho ? ` · ${p.zerados.a_caminho} já a caminho` : ""}`,
        link: "Reposição", destino: { aba: "reposicao" },
      });
    }
    if (!temErro(p.contas)) {
      const inu = noFiltro.reduce((t, c) => t + c.inutil, 0);
      if (inu > 0) {
        const porMkt = ["shopee", "mercadolivre", "amazon"].map((m) => [m, noFiltro.filter((c) => c.marketplace === m).reduce((t, c) => t + c.inutil, 0)] as const)
          .filter(([, v]) => v > 0).map(([m, v]) => `${int(v)} ${m === "mercadolivre" ? "ML" : MKT_NOME[m]}`);
        itens.push({ id: "inutil", sev: "a", n: `${int(inu)} un`, label: "Inutilizáveis paradas no CD", ctx: porMkt.join(" · "), link: "Inventário", destino: { aba: "inventario" } });
      }
    } else naoConferido.push("estoque dos CDs");
    if (temErro(p.tarefas)) naoConferido.push("tarefas");
    else if (p.tarefas.atrasadas.length) {
      const a = p.tarefas.atrasadas;
      itens.push({
        id: "tarefas", sev: "a", n: String(a.length), label: a.length > 1 ? "Tarefas atrasadas" : "Tarefa atrasada",
        ctx: a.slice(0, 2).map((t) => `${t.titulo.length > 38 ? `${t.titulo.slice(0, 38)}…` : t.titulo} (${t.responsavel ?? "sem responsável"}, ${ddmm(t.prazo)})`).join(" · "),
        link: "Tarefas", destino: { aba: "tarefas" },
      });
    } else emDia.push("nenhuma tarefa atrasada");
  }
  const ordem = { r: 0, a: 1, n: 2 };
  itens.sort((a, b) => ordem[a.sev] - ordem[b.sev]);

  // ---------------- abas
  const somar = (k: "com_sugestao" | "anuncios") => noFiltro.reduce((t, c) => t + c[k], 0);
  const envOk = p && !temErro(p.envios) ? p.envios : null;
  const tarOk = p && !temErro(p.tarefas) ? p.tarefas : null;
  const abas: Array<{ id: AbaF; nome: string; n: string | null }> = [
    { id: "envios", nome: "Envios", n: envOk ? String(envOk.abertos) : null },
    { id: "reposicao", nome: "Reposição", n: contas.length ? int(somar("com_sugestao")) : null },
    { id: "inventario", nome: "Inventário", n: contas.length ? int(somar("anuncios")) : null },
    { id: "tarefas", nome: "Tarefas", n: tarOk ? `${tarOk.abertas} ${tarOk.abertas === 1 ? "aberta" : "abertas"}` : null },
  ];

  const grupos = (["ACZ Pet", "SVL Store"] as const).map((e) => ({ emp: e, contas: contas.filter((c) => c.empresa === e) }));

  return (
    <>
      <header className="pm-ui" style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: "10px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600, letterSpacing: "-0.02em" }}>Fulfillment</h1>
          <p style={{ margin: 0, fontSize: 12.5, color: "var(--pm-t3)" }}>Estoque nos centros de distribuição e sugestão de reposição</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: fresh.cor, fontWeight: fresh.fw }}>
              {fresh.alerta && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>}
              {fresh.t}
            </span>
            <span style={{ fontSize: 11, color: "var(--pm-t3)" }}>sincronização automática às 8h e às 18h</span>
          </div>
          <button type="button" onClick={() => void sincronizar()} disabled={rodando}
            title="Puxa agora o estoque de Amazon FBA, Shopee SBS e ML Full das duas empresas — leva ~1 min"
            style={{ display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 12px", borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: rodando ? "default" : "pointer", fontSize: 12.5, fontWeight: 500, color: "var(--pm-t)" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={rodando ? "animate-spin" : undefined}><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
            {rodando ? "Sincronizando…" : "Sincronizar"}
          </button>
        </div>
      </header>

      {/* filtro global */}
      <div className="pm-ui" style={{ position: "sticky", top: 69, zIndex: 20, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 18px", padding: "10px 14px", borderRadius: 14, background: "var(--pm-s)", border: "1px solid var(--pm-b)", boxShadow: "var(--pm-shl)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--pm-t3)", fontWeight: 500 }}>Empresa</span>
          <div style={segGrupo}>
            {([["todas", "Ambas"], ["ACZ Pet", "Ottz Pet"], ["SVL Store", "Bumi Pet"]] as const).map(([id, nome]) => (
              <button key={id} type="button" style={seg(emp === id)} onClick={() => onEmp(id)}>{nome}</button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "var(--pm-t3)", fontWeight: 500 }}>Marketplace</span>
          <div style={segGrupo}>
            {([["todos", "Todos"], ["amazon", "Amazon"], ["mercadolivre", "Mercado Livre"], ["shopee", "Shopee"]] as const).map(([id, nome]) => (
              <button key={id} type="button" style={seg(mkt === id)} onClick={() => onMkt(id)}>
                {id !== "todos" && <span style={logoMini(id)} />}{nome}
              </button>
            ))}
          </div>
        </div>
        {busca}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 8px" }}>
          <span style={{ fontSize: 11.5, color: "var(--pm-t3)", maxWidth: 210, textWrap: "pretty" }}>O estoque no CD é de cada empresa e conta. O que está numa não atende a outra.</span>
          {grupos.map((g) => (
            <div key={g.emp} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 4px 3px 8px", borderRadius: 9, border: "1px dashed var(--pm-bs)" }}>
              <span style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 4, border: "1px solid var(--pm-bs)", color: "var(--pm-t2)", whiteSpace: "nowrap" }}>{NOME_EMP[g.emp]}</span>
              {g.contas.map((c) => (
                <span key={c.shop_id} title={`${nomeConta(c.marketplace, c.empresa)} · ${int(c.anuncios)} anúncios no CD`}
                  style={{ display: "flex", alignItems: "center", gap: 4, height: 22, padding: "0 6px", borderRadius: 6, background: "var(--pm-s2)", fontSize: 11, color: "var(--pm-t2)", opacity: c.no_filtro ? 1 : 0.35, textDecoration: c.no_filtro ? "none" : "line-through" }}>
                  <span style={logoMini(c.marketplace, 13)} />
                  {c.marketplace === "shopee" ? nomeConta(c.marketplace, c.empresa) : c.marketplace === "mercadolivre" ? "ML" : "Amazon"}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Pede ação */}
      <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 12px" }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Pede ação</span>
          <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>por gravidade · vermelho trava a operação ou perde venda agora, âmbar pede atenção{p ? ` · ${idade(p.gerado_em).txt}` : ""}</span>
        </div>
        {painelQ.error ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12, background: "var(--pm-rs)", color: "var(--pm-r)", fontSize: 12.5 }}>
            <b style={{ fontWeight: 600 }}>Não deu para montar a faixa agora.</b>
            <span style={{ color: "var(--pm-t2)" }}>{(painelQ.error as Error).message}. As abas abaixo seguem normais.</span>
            <button type="button" onClick={() => void painelQ.refetch()} style={{ height: 28, padding: "0 10px", borderRadius: 8, border: "1px solid var(--pm-r)", background: "var(--pm-s)", color: "var(--pm-r)", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Tentar de novo</button>
          </div>
        ) : !p ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,170px),1fr))", gap: 8 }}>
            {[0, 1, 2, 3, 4].map((k) => (
              <div key={k} style={{ height: 104, borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ width: "40%", height: 18, borderRadius: 6, background: "var(--pm-sk)" }} />
                <div style={{ width: "80%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
                <div style={{ width: "60%", height: 10, borderRadius: 5, background: "var(--pm-sk)" }} />
              </div>
            ))}
          </div>
        ) : itens.length === 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "10px 14px", borderRadius: 12, background: "var(--pm-s)", border: "1px solid var(--pm-b)", fontSize: 12.5 }}>
            <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--pm-gs)", color: "var(--pm-g)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            </span>
            <b style={{ fontWeight: 600 }}>Tudo em dia ✓</b>
            <span style={{ color: "var(--pm-t3)" }}>{emDia.join(" · ")}</span>
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,170px),1fr))", gap: 8 }}>
              {itens.map((c) => (
                <button key={c.id} type="button" onClick={() => onIr(c.destino)} className="hover:border-[var(--pm-a)]"
                  style={{ textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 3, padding: "10px 12px", borderRadius: 12, border: "1px solid var(--pm-b)", background: "var(--pm-s)", boxShadow: "var(--pm-sh)", minHeight: 104, color: "inherit" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <i style={{ width: 7, height: 7, borderRadius: "50%", background: SEV[c.sev], flex: "none" }} />
                    <span className="pm-mono" style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em", color: SEV[c.sev], whiteSpace: "nowrap" }}>{c.n}</span>
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--pm-t)" }}>{c.label}</span>
                  <span style={{ fontSize: 11.5, color: "var(--pm-t2)", textWrap: "pretty" }}>{c.ctx}</span>
                  <span style={{ fontSize: 11.5, color: "var(--pm-at)", fontWeight: 500, marginTop: "auto" }}>{c.link} →</span>
                </button>
              ))}
            </div>
            {emDia.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", fontSize: 11.5, color: "var(--pm-t3)" }}>
                <span>Em dia:</span>
                {emDia.map((x) => (
                  <span key={x} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--pm-g)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>{x}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        {naoConferido.length > 0 && <span style={{ fontSize: 11, color: "var(--pm-am)" }}>Não deu para conferir agora: {naoConferido.join(", ")}.</span>}
      </div>

      {/* abas */}
      <nav className="pm-ui" style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--pm-b)", overflowX: "auto" }}>
        {abas.map((t) => {
          const on = aba === t.id;
          return (
            <button key={t.id} type="button" onClick={() => onAba(t.id)}
              style={{ border: 0, background: "transparent", cursor: "pointer", padding: "10px 12px 9px", marginBottom: -1, borderBottom: `2px solid ${on ? "var(--pm-a)" : "transparent"}`, display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, fontWeight: on ? 600 : 500, color: on ? "var(--pm-t)" : "var(--pm-t2)", whiteSpace: "nowrap" }}>
              {t.nome}
              {t.n != null && <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 10, background: on ? "var(--pm-as)" : "var(--pm-s2)", color: on ? "var(--pm-at)" : "var(--pm-t2)" }}>{t.n}</span>}
            </button>
          );
        })}
      </nav>
    </>
  );
}

/** Caminho de volta das telas de dentro (envio, novo envio): "Fulfillment › Envios › #79220166". */
export function Migalhas({ itens, onVoltar }: { itens: Array<{ t: string; onClick?: () => void; mono?: boolean }>; onVoltar: () => void }) {
  return (
    <div className="pm-ui" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
      <button type="button" onClick={onVoltar} title="Voltar"
        style={{ width: 34, height: 34, flex: "none", borderRadius: 9, border: "1px solid var(--pm-b)", background: "var(--pm-s)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--pm-t2)" }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
      </button>
      <nav style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, fontSize: 13 }}>
        {itens.map((c, i) => (
          <span key={`${c.t}-${i}`} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {c.onClick
              ? <button type="button" onClick={c.onClick} style={{ border: 0, background: "transparent", padding: 0, cursor: "pointer", fontWeight: 500, color: "var(--pm-at)", fontSize: 13 }}>{c.t}</button>
              : <b className={c.mono ? "pm-mono" : undefined} style={{ fontWeight: 600 }}>{c.t}</b>}
            {i < itens.length - 1 && <span style={{ color: "var(--pm-t3)" }}>›</span>}
          </span>
        ))}
      </nav>
    </div>
  );
}
