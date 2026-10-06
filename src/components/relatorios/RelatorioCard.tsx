import { useId } from "react";

import { Chevron, IconeAgente, IconeRelogio, nomeDoAgente, quandoGerado, type RelatorioLista } from "./comum";
import { agenteDef, ehV0, kindDe } from "./agentes";

// Card do histórico (design "RelatorioCard"): fechado = ícone, título, hora,
// destaque e 3 mini-KPIs à direita (embaixo no celular); aberto = o detalhe do
// agente + rodapé "Gerado às … pelo agente …" e "Ver versão completa".

export function RelatorioCard({
  rel, aberto, onToggle, onCompleta, mobile,
}: {
  rel: RelatorioLista;
  aberto: boolean;
  onToggle: () => void;
  onCompleta: () => void;
  mobile?: boolean;
}) {
  const def = agenteDef(rel.agente);
  const v0 = ehV0(rel);
  const pendente = def?.pendente?.(rel) ?? null;
  const minis = v0 ? [] : def?.mini(rel) ?? [];
  const corpoId = useId();
  const quando = quandoGerado(rel.gerado_em);

  return (
    <div className="rounded-[10px] bg-(--rl-surface) overflow-hidden border"
      style={{ borderColor: aberto ? "var(--rl-border-strong)" : "var(--rl-border)" }}>
      {pendente && (
        <div className="flex items-center gap-2 px-[18px] py-2 bg-(--rl-amber-soft) text-(--rl-amber) text-[12.5px] font-medium border-b border-(--rl-border)">
          <IconeRelogio /> <span>{pendente}</span>
        </div>
      )}
      <button type="button" onClick={onToggle} aria-expanded={aberto} aria-controls={corpoId}
        className="w-full text-left grid gap-3.5 items-start cursor-pointer hover:bg-(--rl-surface-2) text-(--rl-text)"
        style={{
          gridTemplateColumns: mobile || minis.length === 0 ? "32px minmax(0,1fr) 18px" : "32px minmax(0,1fr) auto 18px",
          padding: mobile ? "14px" : "16px 18px",
        }}>
        <IconeAgente kind={kindDe(rel)} />
        <span className="min-w-0 flex flex-col gap-1.5">
          <span className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[15px] font-semibold tracking-[-0.005em]">{rel.titulo ?? nomeDoAgente(rel.agente)}</span>
            {quando && <span className="text-[12px] text-(--rl-text-3)">{quando}</span>}
            {v0 && <span className="text-[11px] font-medium px-[7px] py-px rounded-full bg-(--rl-gray-soft) text-(--rl-text-2)">formato antigo</span>}
          </span>
          <span className="text-[14px] leading-normal max-w-[74ch] [text-wrap:pretty]" style={{ color: v0 ? "var(--rl-text-3)" : "var(--rl-text)" }}>
            {v0 ? "Relatório em formato antigo: só a versão completa está disponível." : rel.destaque ?? "—"}
          </span>
          {mobile && minis.length > 0 && (
            <span className="grid grid-cols-3 gap-2.5 mt-1.5 pt-2.5 border-t border-(--rl-border)">
              {minis.map((k) => (
                <span key={k.label} className="min-w-0">
                  <span className="block text-[11.5px] text-(--rl-text-3)">{k.label}</span>
                  <span className="block text-[15px] font-semibold" style={{ color: k.risco ? "var(--rl-red)" : undefined }}>{k.valor}</span>
                </span>
              ))}
            </span>
          )}
        </span>
        {!mobile && minis.length > 0 && (
          <span className="grid grid-cols-[repeat(3,116px)] gap-3 pt-0.5">
            {minis.map((k) => (
              <span key={k.label} className="min-w-0">
                <span className="block text-[12px] text-(--rl-text-3) whitespace-nowrap">{k.label}</span>
                <span className="block text-[16px] font-semibold whitespace-nowrap" style={{ color: k.risco ? "var(--rl-red)" : undefined }}>{k.valor}</span>
              </span>
            ))}
          </span>
        )}
        <span className="text-(--rl-text-3) mt-1.5"><Chevron aberto={aberto} /></span>
      </button>

      {aberto && (
        <div id={corpoId} className="border-t border-(--rl-border) flex flex-col gap-6"
          style={{ padding: mobile ? "16px 14px" : "22px 24px 18px" }}>
          {v0 || !def ? (
            <div className="flex gap-3 items-start text-[13.5px] leading-normal text-(--rl-text-2)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-(--rl-text-3)" aria-hidden>
                <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M16 13H8" /><path d="M16 17H8" />
              </svg>
              <span>Este relatório foi gerado antes dos blocos (KPIs, tabelas, alertas). Só existe a versão completa em HTML.</span>
            </div>
          ) : (
            <def.Detalhe rel={rel} mobile={mobile} />
          )}
          <RodapeRelatorio rel={rel} onCompleta={onCompleta} />
        </div>
      )}
    </div>
  );
}

export function RodapeRelatorio({ rel, onCompleta }: { rel: RelatorioLista; onCompleta: () => void }) {
  const quando = quandoGerado(rel.gerado_em).replace(/^gerado /, "");
  return (
    <div className="flex justify-between items-center gap-3 flex-wrap pt-4 border-t border-(--rl-border)">
      <div className="text-[12px] text-(--rl-text-3)">
        {quando ? `Gerado ${quando} ` : ""}pelo agente {nomeDoAgente(rel.agente)}. Só análise e sugestão; o app não executa nada.
      </div>
      <BotaoCompleta onClick={onCompleta} />
    </div>
  );
}

export function BotaoCompleta({ onClick, compacto }: { onClick: () => void; compacto?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className="flex items-center gap-1.5 text-[13px] font-medium rounded-[7px] border border-(--rl-border-strong) bg-(--rl-surface) text-(--rl-text) cursor-pointer hover:bg-(--rl-surface-2)"
      style={{ padding: compacto ? "6px 10px" : "7px 12px" }}>
      Ver versão completa
      {!compacto && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        </svg>
      )}
    </button>
  );
}
