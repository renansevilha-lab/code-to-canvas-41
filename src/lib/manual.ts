// ============================================================================
// Manual de Operação — tipos, regras de data e a REGRA DE COMPLETUDE.
//
// Fica separado da tela porque é a alma do sistema: o que conta como "feito"
// decide o contador do dia, o que aparece em âmbar e o relatório do dia.
// ============================================================================

export type Membro = {
  id: string;
  nome: string;
  cor: string;
  email: string | null;
  ativo: boolean;
  ordem: number;
};

export type Callout = { tipo: "warn" | "info"; texto: string };
export type TabelaRef = { head: string[]; rows: string[][] };

export type Secao = {
  code: string;
  tipo: "rotina" | "processo";
  titulo: string;
  descricao: string | null;
  frequencia: string | null;
  responsavel_id: string | null;
  ordem: number;
  callouts: Callout[] | null;
  tabela_ref: TabelaRef | null;
  ativo: boolean;
};

export type Item = {
  id: string;
  secao_code: string;
  tipo: "check" | "pergunta";
  texto: string;
  tags: string[] | null;
  turno: "inicio" | "fim" | null;
  responsavel_id: string | null;
  dias: number[] | null;
  abre_quando: "sim" | "nao" | "nunca" | null;
  campo_label: string | null;
  ordem: number;
  ativo: boolean;
  // Vigência — usada só pelo histórico, para não cobrar um item de um dia em
  // que ele ainda não existia (ou já tinha sido removido).
  criado_em?: string | null;
  desativado_em?: string | null;
};

export type Progresso = {
  id: string;
  dia: string;
  item_id: string;
  concluido: boolean;
  resposta: "sim" | "nao" | null;
  detalhe: string | null;
  por: string | null;
  em: string | null;
};

export type ErroCatalogo = {
  id: string;
  titulo: string;
  tags: string[] | null;
  sintomas: string[] | null;
  teste_rapido: string | null;
  causa_raiz: string | null;
  solucao: string[] | null;
  como_confirmar: string | null;
  quando_escalar: string | null;
  prevencao: string | null;
  ordem: number;
  ativo: boolean;
};

// ---------------------------------------------------------------------------
// Datas — SEMPRE America/Sao_Paulo. O banco roda em UTC: usar CURRENT_DATE ou
// getDay() puro faz o dia virar às 21h e joga a rotina para o dia seguinte.
// ---------------------------------------------------------------------------

/** Hoje no fuso da operação, em YYYY-MM-DD. */
export function hojeSP(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Dia da semana em SP: 0=domingo … 6=sábado (é o que `manual_itens.dias` guarda). */
export function diaSemanaSP(): number {
  const s = new Date().toLocaleDateString("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  });
  const mapa: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return mapa[s.slice(0, 3)] ?? 0;
}

/** Hora cheia (0–23) em SP — decide saudação e turno sugerido. */
export function horaSP(): number {
  return Number(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hour12: false,
    }),
  );
}

export function dataExtensoSP(): string {
  const s = new Date().toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    timeZone: "America/Sao_Paulo",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function saudacao(): string {
  const h = horaSP();
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

/** Antes das 14h o dia ainda é da rotina matinal; depois, do encerramento. */
export function turnoSugerido(): "inicio" | "fim" {
  return horaSP() < 14 ? "inicio" : "fim";
}

export function horaCurtaSP(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const NOMES_DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/**
 * Dia da semana de uma data YYYY-MM-DD (0=domingo).
 * Via Date.UTC de propósito: `new Date("2026-08-19")` seria interpretado como
 * meia-noite UTC e, num navegador a oeste de Greenwich, cairia no dia anterior.
 */
export function diaSemanaDe(dia: string): number {
  const [ano, mes, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(ano, (mes ?? 1) - 1, d ?? 1)).getUTCDay();
}

/** Soma (ou subtrai) dias de uma data YYYY-MM-DD, sem passar por fuso. */
export function somarDias(dia: string, n: number): string {
  const [ano, mes, d] = dia.split("-").map(Number);
  const base = new Date(Date.UTC(ano, (mes ?? 1) - 1, d ?? 1));
  base.setUTCDate(base.getUTCDate() + n);
  return base.toISOString().slice(0, 10);
}

export function dataExtensoDe(dia: string): string {
  const [ano, mes, d] = dia.split("-").map(Number);
  const s = new Date(Date.UTC(ano, (mes ?? 1) - 1, d ?? 1)).toLocaleDateString("pt-BR", {
    weekday: "long", day: "2-digit", month: "long", timeZone: "UTC",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * O item valia naquela data? Evita que o histórico cobre item criado depois
 * (falso pendente) ou esconda item que existia e foi removido.
 * Compara pela DATA em SP, não pelo instante — criar um item às 23h não pode
 * tirá-lo do próprio dia.
 */
export function vigenteEm(item: Item, dia: string): boolean {
  const diaDe = (iso: string | null | undefined): string | null =>
    iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) : null;

  const nasceu = diaDe(item.criado_em);
  if (nasceu && dia < nasceu) return false;

  const morreu = diaDe(item.desativado_em);
  if (morreu && dia > morreu) return false;

  // Sem data de desativação, item inativo é tratado como nunca vigente no
  // passado apenas se não houver registro — quem decide isso é a tela.
  return true;
}

// ---------------------------------------------------------------------------
// Recorrência e completude
// ---------------------------------------------------------------------------

/** `dias` null/vazio = todo dia. Caso contrário, só nos dias listados. */
export function rodaHoje(item: Item, dow: number): boolean {
  if (!item.dias || item.dias.length === 0) return true;
  return item.dias.includes(dow);
}

/** Responsável efetivo: o do item; se null, herda o da seção. */
export function responsavelDe(item: Item, secao: Secao | undefined): string | null {
  return item.responsavel_id ?? secao?.responsavel_id ?? null;
}

/**
 * O campo de detalhe é obrigatório quando a resposta dada é justamente a que
 * "abre" o campo (e a seção não usa 'nunca'). É isso que impede um "não" seco
 * de fechar o dia sem explicação.
 */
export function exigeDetalhe(item: Item, resposta: "sim" | "nao" | null | undefined): boolean {
  if (item.tipo !== "pergunta" || !resposta) return false;
  if (!item.abre_quando || item.abre_quando === "nunca") return false;
  return resposta === item.abre_quando;
}

/**
 * REGRA DE COMPLETUDE
 *  - check: existe progresso com concluido = true
 *  - pergunta: tem resposta E, se essa resposta abre o campo, o detalhe está
 *    preenchido. Pergunta respondida "não" sem motivo NÃO está completa.
 */
export function itemCompleto(item: Item, prog: Progresso | undefined): boolean {
  if (!prog) return false;
  if (item.tipo === "check") return prog.concluido === true;
  if (!prog.resposta) return false;
  if (exigeDetalhe(item, prog.resposta)) return !!prog.detalhe && prog.detalhe.trim().length > 0;
  return true;
}

/** Respondida, mas parada na pendência do detalhe — é o destaque âmbar da tela. */
export function faltaDetalhe(item: Item, prog: Progresso | undefined): boolean {
  if (!prog || item.tipo !== "pergunta" || !prog.resposta) return false;
  return exigeDetalhe(item, prog.resposta) && !(prog.detalhe && prog.detalhe.trim());
}

// ---------------------------------------------------------------------------
// Relatório do dia — TEXTO PURO (vai para WhatsApp/Discord; nada de markdown,
// asterisco vira ruído nesses apps).
// ---------------------------------------------------------------------------

export function montarRelatorio(params: {
  itens: Item[];
  secoes: Secao[];
  membros: Membro[];
  progresso: Map<string, Progresso>;
  dow: number;
  dataLabel: string;
}): string {
  const { itens, secoes, membros, progresso, dow, dataLabel } = params;
  const secaoDe = new Map(secoes.map((s) => [s.code, s]));

  const doDia = itens.filter((i) => {
    const s = secaoDe.get(i.secao_code);
    return s?.tipo === "rotina" && rodaHoje(i, dow);
  });

  const linhas: string[] = [];
  linhas.push("RELATORIO DO DIA");
  linhas.push(dataLabel);
  linhas.push("");

  const pendentes: string[] = [];
  let feitos = 0;

  for (const membro of membros) {
    const meus = doDia.filter((i) => responsavelDe(i, secaoDe.get(i.secao_code)) === membro.id);
    if (meus.length === 0) continue;

    linhas.push(`--- ${membro.nome.toUpperCase()} ---`);

    for (const turno of ["inicio", "fim"] as const) {
      const doTurno = meus.filter((i) => i.turno === turno);
      if (doTurno.length === 0) continue;

      linhas.push(turno === "inicio" ? "" : "");
      linhas.push(turno === "inicio" ? "Rotina matinal:" : "Encerramento:");

      for (const item of doTurno) {
        const prog = progresso.get(item.id);
        const completo = itemCompleto(item, prog);
        if (completo) feitos++;

        if (item.tipo === "check") {
          linhas.push(`  [${completo ? "x" : " "}] ${item.texto}`);
          if (!completo) pendentes.push(`${membro.nome}: ${item.texto}`);
          continue;
        }

        // pergunta
        const marca = completo ? "x" : prog?.resposta ? "!" : " ";
        const resp = prog?.resposta ? prog.resposta.toUpperCase() : "SEM RESPOSTA";
        linhas.push(`  [${marca}] ${item.texto} -> ${resp}`);

        if (exigeDetalhe(item, prog?.resposta)) {
          const det = prog?.detalhe?.trim();
          linhas.push(`      ${item.campo_label ?? "Descreva"}: ${det || "*** NAO PREENCHIDO ***"}`);
        }
        if (!completo) {
          pendentes.push(
            `${membro.nome}: ${item.texto}${prog?.resposta ? " (falta descrever)" : " (sem resposta)"}`,
          );
        }
      }
    }
    linhas.push("");
  }

  linhas.push("--- RESUMO ---");
  linhas.push(`Concluidos: ${feitos} de ${doDia.length}`);
  if (pendentes.length === 0) {
    linhas.push("Nenhuma pendencia. Dia fechado.");
  } else {
    linhas.push(`Pendentes: ${pendentes.length}`);
    for (const p of pendentes) linhas.push(`  - ${p}`);
  }

  return linhas.join("\n");
}
