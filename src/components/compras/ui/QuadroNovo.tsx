// Quadro de Compras e Recebimento no visual novo (16/nov/2026, aprovado pelo dono):
// faixa "Pede ação" → lista por etapa, cada ordem com a linha do tempo de 6 passos
// (com a data de cada um) e UM botão de próximo passo. Só apresentação: quem lê e
// grava é a rota (src/routes/compras.tsx).
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare, RefreshCw } from "lucide-react";

import { formatBRL, formatNumber } from "@/lib/format";
import { Spinner } from "@/components/separacao/ui/kit";
import {
  type Grupo, type OrdemQuadro, type Passo, atrasoDias, diaMes, faltaFechar, fornecedorDe, grupoDe, num,
  passosDe, proximoPasso, rotuloOrdem,
} from "./defs";
import { BotaoR, Busca, Progresso, SeloR, Trilha, cartaoR, kicker, mini, tnum } from "./pecas";

export interface QuadroNovoProps {
  ordens: OrdemQuadro[];
  carregando: boolean;
  erro: string | null;
  ehAdm: boolean;
  notasSemOrdem: number | null;
  notasTotal: number | null;
  sincronizando: boolean;
  onSincronizar: () => void;
  onAbrir: (tinyId: number) => void;
  onChegou: (o: OrdemQuadro) => void;
  onFeitoNoTiny: (o: OrdemQuadro, passo: "estoque" | "contas" | "custo") => void;
  onNovaEntrada: () => void;
  onIrNotas: () => void;
}

const NOME_GRUPO: Record<Grupo, { nome: string; sub: string }> = {
  andamento: { nome: "Chegou, em andamento", sub: "Cada linha mostra onde a ordem parou e o próximo passo" },
  aguardando: { nome: "Aguardando chegar", sub: "Do mais atrasado para o mais novo" },
  fechar: { nome: "Recebidas, falta fechar", sub: "Conferência concluída, mas falta estoque, contas ou custo" },
  orcamento: { nome: "Orçamentos", sub: "Ainda não viraram pedido" },
  fechada: { nome: "Fechadas", sub: "Recebidas e encerradas" },
};
const ORDEM_GRUPOS: Grupo[] = ["andamento", "aguardando", "fechar", "orcamento", "fechada"];
const NOME_PASSO: Record<"estoque" | "contas" | "custo", string> = { estoque: "o estoque", contas: "as contas a pagar", custo: "o custo" };

export function QuadroNovo(p: QuadroNovoProps) {
  const [busca, setBusca] = useState("");
  const [foco, setFoco] = useState<Grupo | null>(null);
  const [abertos, setAbertos] = useState<Record<string, boolean>>({ andamento: true, aguardando: true, fechar: true });
  const [verTudo, setVerTudo] = useState<Record<string, boolean>>({});

  const porGrupo = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const m: Record<Grupo, OrdemQuadro[]> = { andamento: [], aguardando: [], fechar: [], orcamento: [], fechada: [] };
    for (const o of p.ordens) {
      if (q) {
        const alvo = `${rotuloOrdem(o)} ${o.numero ?? ""} ${fornecedorDe(o)} ${o.nf_numero ?? ""}`.toLowerCase();
        if (!alvo.includes(q)) continue;
      }
      m[grupoDe(o)].push(o);
    }
    m.aguardando.sort((a, b) => atrasoDias(b) - atrasoDias(a) || (a.data_pedido ?? "").localeCompare(b.data_pedido ?? ""));
    m.fechar.sort((a, b) => (b.recebido_em ?? b.data_pedido ?? "").localeCompare(a.recebido_em ?? a.data_pedido ?? ""));
    m.fechada.sort((a, b) => (b.recebido_em ?? b.data_pedido ?? "").localeCompare(a.recebido_em ?? a.data_pedido ?? ""));
    return m;
  }, [p.ordens, busca]);

  // ---- Pede ação (sempre sobre todas as ordens, sem a busca) ----
  const acao = useMemo(() => {
    const atrasadas = p.ordens.filter((o) => atrasoDias(o) > 0);
    const conferir = p.ordens.filter((o) => o.kanban_status === "conferencia");
    const diverg = p.ordens.filter((o) => o.kanban_status === "divergente");
    const fechar = p.ordens.filter((o) => grupoDe(o) === "fechar");
    return {
      atrasadas, conferir, diverg, fechar,
      semContas: fechar.filter((o) => !o.contas_lancadas_em).length,
      semEstoque: fechar.filter((o) => !o.estoque_lancado_em).length,
    };
  }, [p.ordens]);

  const irPara = (g: Grupo) => {
    setFoco(g);
    setAbertos((a) => ({ ...a, [g]: true }));
    requestAnimationFrame(() => document.getElementById(`cp-grupo-${g}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const nomes = (l: OrdemQuadro[]) => {
    const u = Array.from(new Set(l.map(fornecedorDe)));
    return u.slice(0, 2).join(" e ") + (u.length > 2 ? ` e mais ${u.length - 2}` : "");
  };

  const cartoes: Array<{ k: string; tom: "r" | "a" | "z"; n: string; peq?: string; l: string; c: string; on: () => void }> = [];
  if (acao.atrasadas.length) cartoes.push({
    k: "atr", tom: "r", n: String(acao.atrasadas.length),
    peq: p.ehAdm ? formatBRL(acao.atrasadas.reduce((s, o) => s + num(o.total_pedido), 0), { compact: true }) : undefined,
    l: "Atrasadas do fornecedor", c: nomes(acao.atrasadas), on: () => irPara("aguardando"),
  });
  if (acao.conferir.length) cartoes.push({
    k: "conf", tom: "a", n: String(acao.conferir.length),
    peq: `${formatNumber(acao.conferir.reduce((s, o) => s + Math.max(0, num(o.ped) - num(o.rec)), 0))} un`,
    l: "Chegaram, falta conferir", c: nomes(acao.conferir), on: () => irPara("andamento"),
  });
  if (acao.diverg.length) cartoes.push({
    k: "div", tom: "r", n: String(acao.diverg.length), l: acao.diverg.length === 1 ? "Divergência aberta" : "Divergências abertas",
    c: nomes(acao.diverg), on: () => irPara("andamento"),
  });
  if (acao.fechar.length) cartoes.push({
    k: "fech", tom: "a", n: String(acao.fechar.length), peq: "em 60 dias", l: "Recebidas, falta fechar",
    c: `${acao.semContas} sem contas a pagar · ${acao.semEstoque} sem estoque lançado`, on: () => irPara("fechar"),
  });
  if (p.notasSemOrdem) cartoes.push({
    k: "nf", tom: "z", n: String(p.notasSemOrdem), peq: p.notasTotal != null ? `de ${p.notasTotal} notas` : undefined,
    l: "Notas de entrada sem ordem", c: "Últimos 30 dias, sem frete e retorno do Full", on: p.onIrNotas,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* topo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Busca valor={busca} onValor={setBusca} placeholder="Fornecedor, nº da ordem ou nota" />
        <div style={{ flex: 1 }} />
        <BotaoR onClick={p.onSincronizar} disabled={p.sincronizando} title="Relê as ordens de compra e as notas de entrada do Tiny">
          {p.sincronizando ? <Spinner size={13} /> : <RefreshCw size={13} />} Atualizar do Tiny
        </BotaoR>
        <BotaoR tom="primario" onClick={p.onNovaEntrada} title="Mercadoria chegou com nota e sem ordem de compra: cria a entrada pelo XML da nota">
          Chegou mercadoria sem ordem
        </BotaoR>
      </div>

      {/* pede ação */}
      <div>
        <div style={{ ...kicker, marginBottom: 8 }}>Pede ação</div>
        {p.carregando ? (
          <div style={{ ...mini, display: "flex", alignItems: "center", gap: 8 }}><Spinner /> Lendo as ordens…</div>
        ) : cartoes.length === 0 ? (
          <div style={{ ...cartaoR, padding: "12px 16px", color: "var(--pm-g)", fontWeight: 500 }}>Nada pede ação agora: sem atraso, sem carga parada e sem recebimento por fechar.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(215px, 1fr))", gap: 10 }}>
            {cartoes.map((c) => (
              <button key={c.k} type="button" onClick={c.on} className="pm-hv"
                style={{
                  ...cartaoR, borderRadius: 20, padding: "13px 16px 13px 22px", display: "flex", flexDirection: "column", gap: 2,
                  position: "relative", cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "var(--pm-t)",
                }}>
                <span style={{ position: "absolute", left: 10, top: 15, bottom: 15, width: 5, borderRadius: 5, background: c.tom === "r" ? "var(--pm-r)" : c.tom === "a" ? "var(--pm-am)" : "var(--pm-a)" }} />
                <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: "-.02em", ...tnum }}>
                  {c.n}{c.peq && <small style={{ fontSize: 12, fontWeight: 500, color: "var(--pm-t3)", marginLeft: 6 }}>{c.peq}</small>}
                </span>
                <span style={{ fontWeight: 600, fontSize: 12.5 }}>{c.l}</span>
                <span style={mini}>{c.c}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {p.erro && <div style={{ ...cartaoR, padding: "12px 16px", color: "var(--pm-r)" }}>Não consegui ler as ordens: {p.erro}</div>}

      {/* grupos */}
      {!p.carregando && ORDEM_GRUPOS.map((g) => {
        const lista = porGrupo[g];
        if (lista.length === 0 && (g === "andamento" || g === "fechar" || g === "orcamento") && !busca) {
          if (g !== "andamento") return null;
        }
        const aberto = !!abertos[g] || (!!busca && lista.length > 0);
        const limite = g === "fechada" ? 30 : g === "fechar" ? 8 : 200;
        const mostra = verTudo[g] ? lista : lista.slice(0, limite);
        const resumoOrc = g === "orcamento" && p.ehAdm
          ? lista.slice(0, 3).map((o) => `${fornecedorDe(o)} ${formatBRL(num(o.total_pedido), { compact: true })}`).join(" · ")
          : NOME_GRUPO[g].sub;
        return (
          <section key={g} id={`cp-grupo-${g}`} style={{ ...cartaoR, outline: foco === g ? "2px solid var(--pm-a)" : undefined, scrollMarginTop: 80 }}>
            <button type="button" onClick={() => { setAbertos((a) => ({ ...a, [g]: !aberto })); setFoco(null); }}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", width: "100%", background: "transparent", border: 0,
                borderBottom: aberto && lista.length ? "1px solid var(--pm-b)" : undefined, cursor: "pointer", fontFamily: "inherit", color: "var(--pm-t)", textAlign: "left",
              }}>
              {aberto ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <span style={{ fontSize: 14, fontWeight: 600 }}>{NOME_GRUPO[g].nome}</span>
              <span style={{ fontWeight: 700, background: "var(--pm-s2)", borderRadius: 999, padding: "1px 9px", fontSize: 12, ...tnum }}>{lista.length}</span>
              <span style={{ ...mini, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{resumoOrc}</span>
            </button>
            {aberto && lista.length === 0 && (
              <div style={{ padding: "14px 16px", ...mini }}>{busca ? "Nada com essa busca." : "Nenhuma ordem nesta etapa."}</div>
            )}
            {aberto && mostra.map((o, i) => (
              <LinhaOrdem key={o.tiny_id} o={o} grupo={g} ehAdm={p.ehAdm} ultimo={i === mostra.length - 1 && mostra.length === lista.length}
                onAbrir={p.onAbrir} onChegou={p.onChegou} onFeitoNoTiny={p.onFeitoNoTiny} />
            ))}
            {aberto && lista.length > mostra.length && (
              <div style={{ padding: "10px 16px" }}>
                <BotaoR pequeno onClick={() => setVerTudo((v) => ({ ...v, [g]: true }))}>Ver as {lista.length}</BotaoR>
              </div>
            )}
          </section>
        );
      })}
      <style>{`@media (max-width: 900px){ .pm-ui .cp-linha { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}

function LinhaOrdem({ o, grupo, ehAdm, ultimo, onAbrir, onChegou, onFeitoNoTiny }: {
  o: OrdemQuadro; grupo: Grupo; ehAdm: boolean; ultimo: boolean;
  onAbrir: (id: number) => void; onChegou: (o: OrdemQuadro) => void;
  onFeitoNoTiny: (o: OrdemQuadro, passo: "estoque" | "contas" | "custo") => void;
}) {
  const passos: Passo[] = passosDe(o);
  const atraso = atrasoDias(o);
  const ped = num(o.ped) || num(o.itens_qtd), rec = num(o.rec);
  const dif = rec - ped;
  const falta = grupo === "fechar" ? (faltaFechar(o) as "estoque" | "contas" | "custo" | null) : null;
  const parar = (f: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); f(); };

  const linha2: string[] = [];
  if (grupo === "aguardando" || grupo === "orcamento") linha2.push(`pedido ${diaMes(o.data_pedido)}`);
  else if (o.recebido_em) linha2.push(`recebida ${diaMes(o.recebido_em)}`);
  else if (o.nf_em) linha2.push(`chegou ${diaMes(o.nf_em)}`);
  else linha2.push(`pedido ${diaMes(o.data_pedido)}`);
  if (num(o.n_itens) > 0) linha2.push(`${o.n_itens} ${o.n_itens === 1 ? "produto" : "produtos"}`);
  if (ehAdm && num(o.total_pedido) > 0) linha2.push(formatBRL(num(o.total_pedido)));

  return (
    <div className="cp-linha pm-linha-hv" role="button" tabIndex={0} onClick={() => onAbrir(o.tiny_id)}
      onKeyDown={(e) => { if (e.key === "Enter") onAbrir(o.tiny_id); }}
      style={{
        display: "grid", gridTemplateColumns: "minmax(210px,1.3fr) minmax(150px,.8fr) minmax(300px,1.5fr) auto", gap: 14, alignItems: "center",
        padding: "12px 16px", borderBottom: ultimo ? undefined : "1px solid var(--pm-b)", cursor: "pointer",
      }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600, ...tnum }}>{rotuloOrdem(o)}</span>
          {o.tiny_id < 0 && <SeloR tom="z">entrada por nota</SeloR>}
          {o.kanban_status === "divergente" && <SeloR tom="r">divergência</SeloR>}
          {o.divergencia_oc_nf && <SeloR tom="a" title="As quantidades da ordem diferem das da nota; a conferência usa a nota">ordem ≠ nota</SeloR>}
        </div>
        <div style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{fornecedorDe(o)}</div>
        <div style={mini}>{linha2.join(" · ")}</div>
        {num(o.apont_n) > 0 && (
          <div style={{ ...mini, display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
            <MessageSquare size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {o.apont_n} {o.apont_n === 1 ? "apontamento" : "apontamentos"} · “{o.apont_ultimo}”
            </span>
          </div>
        )}
      </div>

      <div style={{ minWidth: 0 }}>
        {grupo === "aguardando" ? (
          <>
            {atraso > 0 ? <SeloR tom="r">{atraso} {atraso === 1 ? "dia" : "dias"} de atraso</SeloR>
              : o.data_prevista ? <SeloR tom="n">no prazo</SeloR> : <SeloR tom="a">sem previsão</SeloR>}
            <div style={mini}>{o.data_prevista ? `previsto ${diaMes(o.data_prevista)}` : "previsão não informada no Tiny"} · {formatNumber(ped)} un</div>
          </>
        ) : grupo === "orcamento" ? (
          <div style={mini}>{formatNumber(ped)} un</div>
        ) : (
          <>
            <div style={mini}>Conferido</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <b style={tnum}>{formatNumber(rec)} / {formatNumber(ped)} un</b>
              {dif !== 0 && rec > 0 && grupo !== "andamento" && <SeloR tom="r">{dif > 0 ? "+" : ""}{formatNumber(dif)}</SeloR>}
              {o.kanban_status === "divergente" && dif !== 0 && <SeloR tom="r">{dif > 0 ? "+" : ""}{formatNumber(dif)}</SeloR>}
            </div>
            <Progresso feito={rec} total={ped} cor={o.kanban_status === "divergente" ? "var(--pm-am)" : undefined} />
          </>
        )}
      </div>

      <Trilha passos={passos} />

      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
        {falta && (
          <BotaoR pequeno onClick={parar(() => onFeitoNoTiny(o, falta))}
            title={`Marca ${NOME_PASSO[falta]} como já feito direto no Tiny, sem lançar nada`}>
            Já fiz no Tiny
          </BotaoR>
        )}
        <BotaoR pequeno tom={grupo === "fechada" || grupo === "orcamento" ? "contorno" : "primario"}
          onClick={parar(() => (grupo === "aguardando" ? onChegou(o) : onAbrir(o.tiny_id)))}>
          {proximoPasso(o)} ›
        </BotaoR>
      </div>
    </div>
  );
}
