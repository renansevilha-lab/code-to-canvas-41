import {
  arr, brl, ddmm, Notas, num, numOuNull, obj, Pill, Secao, str, type RelatorioLista,
} from "./comum";
import type { Decisao, MiniKpi } from "./tipos";

// ============================================================================
// Card aberto do agente de Pesquisa de produtos ML (resumo = pesquisa_ml_relatorio_diario(),
// versao 'v1'): kpis{}, defesa[] (minha posição hoje × coleta anterior × 7 dias, quem está acima,
// novos e saídas do top 20), descoberta{varredura, categorias[]}, tendencias[], decisoes[], coleta{}.
// Só leitura. A tela completa é /pesquisa-produtos.
// ============================================================================

const pos = (x: unknown) => (numOuNull(x) == null ? "—" : `${num(x)}º`);

export function miniPesquisa(rel: RelatorioLista): MiniKpi[] {
  const k = obj(rel.resumo?.kpis);
  const cairam = num(k.cairam);
  return [
    { label: "No top 20", valor: `${num(k.no_top)} de ${num(k.categorias_monitoradas)}` },
    { label: "Melhor posição", valor: pos(k.melhor_posicao) },
    { label: "Caíram", valor: String(cairam), risco: cairam > 0 },
  ];
}

/** O agente manda pronto em resumo.decisoes (agentes.ts lê de lá); aqui é só o reserva. */
export function decisoesPesquisa(rel: RelatorioLista): Decisao[] {
  return arr(rel.resumo?.decisoes).slice(0, 3).map((d) => ({
    tom: d.tom === "red" || d.tom === "amber" ? d.tom : "gray", oQue: str(d.o_que), detalhe: str(d.detalhe),
  }));
}

export function pesquisaPendente(rel: RelatorioLista): string | null {
  const a = obj(rel.resumo?.coleta).aviso;
  return a ? str(a) : null;
}

function Delta({ v }: { v: unknown }) {
  const d = numOuNull(v);
  if (d == null || d === 0) return null;
  return <span style={{ color: d > 0 ? "var(--rl-green)" : "var(--rl-red)" }} className="ml-1 text-[12px] font-semibold">{d > 0 ? `▲${d}` : `▼${Math.abs(d)}`}</span>;
}
const MOV: Record<string, { cor: "accent" | "green" | "red" | "gray"; t: string }> = {
  novo: { cor: "accent", t: "novo" }, subiu: { cor: "green", t: "subiu" }, caiu: { cor: "red", t: "caiu" },
};

export function RelatorioPesquisaML({ rel, mobile }: { rel: RelatorioLista; mobile?: boolean }) {
  const res = rel.resumo ?? {};
  const defesa = arr(res.defesa);
  const desc = obj(res.descoberta);
  const tend = arr(res.tendencias);
  const coleta = obj(res.coleta);
  const notas: string[] = [];
  if (coleta.aviso) notas.push(str(coleta.aviso));
  if (num(coleta.erros_hoje) > 0) notas.push(`${num(coleta.erros_hoje)} categoria(s) com erro na coleta de hoje (tentam de novo na próxima rodada).`);
  if (defesa.length && defesa.every((c) => c.data_ontem == null)) notas.push("Primeira coleta: a comparação com o dia anterior e com 7 dias começa nas próximas.");
  notas.push("Top 20 do Mercado Livre por categoria (quase todo de produtos de catálogo). Para anúncios de outros vendedores o ML não libera nome nem preço — aparece o código.");

  return (
    <div className="flex flex-col gap-7">
      <Secao titulo="Defesa — onde estou no top 20" nota="hoje × coleta anterior · ▲ subiu ▼ caiu">
        <div className={mobile ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 lg:grid-cols-2 gap-3"}>
          {defesa.map((c) => {
            const acima = arr(c.acima);
            const novos = arr(c.novos);
            const sairam = arr(c.sairam);
            return (
              <div key={str(c.category_id)} className="rounded-xl border border-(--rl-border) p-3.5 flex flex-col gap-2 min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-[14px] truncate">{str(c.categoria)}</div>
                    <div className="text-[11.5px] text-(--rl-text-3) truncate">{str(c.caminho)}</div>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    {c.saiu_do_top ? <Pill cor="red-solid">fora do top 20</Pill>
                      : <span className="text-[22px] font-semibold">{pos(c.minha_posicao)}</span>}
                    <Delta v={c.delta_ontem} />
                    <div className="text-[11px] text-(--rl-text-3)">
                      {c.posicao_ontem != null ? `antes ${pos(c.posicao_ontem)}` : ""}{c.posicao_7d != null ? ` · 7 dias ${pos(c.posicao_7d)}` : ""}
                    </div>
                  </div>
                </div>
                {arr(c.meus).map((m, i) => (
                  <div key={i} className="text-[12.5px] truncate" title={str(m.titulo)}>
                    <b>{pos(m.posicao)}</b> {str(m.titulo)} <span className="text-(--rl-text-3)">· {str(m.conta) === "svl" ? "SVL" : "Ottz"}</span>
                  </div>
                ))}
                {acima.length > 0 && (
                  <div className="text-[12px] text-(--rl-text-2)">
                    <div className="text-[11px] uppercase tracking-wide text-(--rl-text-3) mb-0.5">Logo acima</div>
                    {acima.map((a, i) => (
                      <div key={i} className="flex gap-1.5 items-center min-w-0">
                        <span className="w-7 shrink-0">{pos(a.posicao)}</span>
                        <span className="truncate flex-1" title={str(a.titulo)}>{str(a.titulo)}</span>
                        {a.preco != null && <span className="whitespace-nowrap">{brl(a.preco)}</span>}
                        {MOV[str(a.movimento)] && <Pill cor={MOV[str(a.movimento)].cor}>{MOV[str(a.movimento)].t}</Pill>}
                      </div>
                    ))}
                  </div>
                )}
                {(novos.length > 0 || sairam.length > 0) && (
                  <div className="text-[12px] text-(--rl-text-2)">
                    {novos.length > 0 && <div>Entraram: {novos.map((n) => `${pos(n.posicao)} ${str(n.titulo).slice(0, 40)}`).join(" · ")}</div>}
                    {sairam.length > 0 && <div>Saíram: {sairam.map((n) => `${str(n.titulo).slice(0, 40)} (era ${pos(n.posicao_ontem)})`).join(" · ")}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Secao>

      <Secao titulo="Descoberta — categorias em que não atuo" nota={desc.varredura ? `varredura de ${ddmm(str(desc.varredura))} · domingo` : "sem varredura ainda"}>
        <div className="flex flex-col divide-y divide-(--rl-border) text-[12.5px]">
          {arr(desc.categorias).map((c, i) => (
            <div key={i} className="py-1.5 flex gap-3 items-center min-w-0">
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">{str(c.categoria)}</div>
                <div className="text-[11px] text-(--rl-text-3) truncate" title={str(c.lider)}>1º: {str(c.lider) || "—"}</div>
              </div>
              {num(c.novos) > 0 && <Pill cor="accent">{num(c.novos)} novos</Pill>}
              <span className="whitespace-nowrap text-(--rl-text-2)">{c.preco_min != null ? `${brl(c.preco_min)} – ${brl(c.preco_max)}` : "—"}</span>
            </div>
          ))}
        </div>
      </Secao>

      <Secao titulo="Buscas em alta no Pet Shop" nota="semana × semana anterior">
        <div className={mobile ? "grid grid-cols-1 gap-1" : "grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-1"}>
          {tend.map((t, i) => (
            <div key={i} className="flex gap-2 items-center text-[12.5px] min-w-0">
              <span className="w-8 shrink-0 text-(--rl-text-3)">{pos(t.posicao)}</span>
              <span className="truncate flex-1 font-medium">{str(t.palavra)}</span>
              <span className="text-[11px] text-(--rl-text-3) truncate max-w-[40%]">{str(t.categoria)}</span>
              {MOV[str(t.movimento)] && <Pill cor={MOV[str(t.movimento)].cor}>{MOV[str(t.movimento)].t}</Pill>}
            </div>
          ))}
        </div>
      </Secao>

      <Secao titulo="Qualidade dos dados">
        <Notas itens={notas} />
      </Secao>
    </div>
  );
}
