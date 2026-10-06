import type { ComponentType } from "react";

import { kindDoAgente, str, type Kind, type RelatorioLista } from "./comum";
import { decisoesFin, miniFin, RelatorioFinanceiro } from "./RelatorioFinanceiro";
import { decisoesCompras, miniCompras, RelatorioCompras } from "./RelatorioCompras";
import { adsPendente, adsV0, decisoesAds, miniAds, RelatorioAds } from "./RelatorioAds";
import type { Decisao, MiniKpi } from "./tipos";

// Mapa agente → mini-KPIs (card fechado / faixa Hoje), "Pede decisão",
// aviso de dado pendente e o card aberto. Agente novo = uma entrada aqui;
// sem entrada, o card só oferece a versão completa.

interface AgenteDef {
  kind: Kind;
  mini: (rel: RelatorioLista) => MiniKpi[];
  decisoes: (rel: RelatorioLista) => Decisao[];
  pendente?: (rel: RelatorioLista) => string | null;
  v0?: (rel: RelatorioLista) => boolean;
  Detalhe: ComponentType<{ rel: RelatorioLista; mobile?: boolean }>;
}

const AGENTES: Record<string, AgenteDef> = {
  financeiro: { kind: "fin", mini: miniFin, decisoes: decisoesFin, Detalhe: RelatorioFinanceiro },
  compras: { kind: "compras", mini: miniCompras, decisoes: decisoesCompras, Detalhe: RelatorioCompras },
  ads: { kind: "ads", mini: miniAds, decisoes: decisoesAds, pendente: adsPendente, v0: adsV0, Detalhe: RelatorioAds },
};

export function agenteDef(agente: string): AgenteDef | null {
  return AGENTES[agente] ?? null;
}

/** Relatório sem blocos (formato antigo / agente sem tela): só a versão completa. */
export function ehV0(rel: RelatorioLista): boolean {
  const d = AGENTES[rel.agente];
  if (!d) return true;
  if (str(rel.resumo?.versao).startsWith("v0")) return true;
  return d.v0 ? d.v0(rel) : false;
}

/** "Pede decisão": o agente pode mandar pronto em resumo.decisoes; senão, tira do resumo. */
export function decisoesDe(rel: RelatorioLista): Decisao[] {
  const prontas = rel.resumo?.decisoes;
  if (Array.isArray(prontas) && prontas.length > 0) {
    return (prontas as Record<string, unknown>[]).slice(0, 3).map((d) => ({
      tom: d.tom === "red" || d.tom === "amber" ? d.tom : "gray",
      oQue: str(d.o_que ?? d.oQue),
      detalhe: str(d.detalhe),
      sku: d.sku ? str(d.sku) : null,
      rotulo: d.rotulo ? str(d.rotulo) : undefined,
    }));
  }
  if (ehV0(rel)) return [];
  return AGENTES[rel.agente]?.decisoes(rel) ?? [];
}

export const kindDe = (rel: RelatorioLista): Kind => AGENTES[rel.agente]?.kind ?? kindDoAgente(rel.agente);
