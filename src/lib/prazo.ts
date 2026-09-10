// ============================================================================
// Prazo de despacho (ship_by_date) — helpers puros, compartilhados entre a
// Separação e o Monitoramento. O ship_by_date é o fim do dia-limite (23:59 em
// São Paulo), então tudo aqui compara por DIA no fuso de São Paulo.
// ============================================================================

/** Faixas EXCLUSIVAS do filtro de prazo (cada linha cai numa só). */
export const FAIXAS_PRAZO: Array<{ id: string; label: string; curto: string }> = [
  { id: "vencidos", label: "⚠ Vencidos", curto: "Vencidos" },
  { id: "0", label: "Vence hoje", curto: "Hoje" },
  { id: "1", label: "Amanhã", curto: "Amanhã" },
  { id: "2", label: "Em 2 dias", curto: "2d" },
  { id: "3", label: "Em 3 dias", curto: "3d" },
  { id: "5", label: "4 a 5 dias", curto: "4-5d" },
  { id: "mais", label: "6+ dias", curto: "6d+" },
  { id: "sem", label: "Sem prazo", curto: "s/ prazo" },
];

export function faixaPrazo(dias: number | null): string {
  if (dias === null) return "sem";
  if (dias < 0) return "vencidos";
  if (dias <= 3) return String(dias);
  if (dias <= 5) return "5";
  return "mais";
}

/** Diferença em DIAS (por data em São Paulo) entre o prazo e hoje. */
export function diasAtePrazo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const diaSP = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // yyyy-mm-dd
  const hoje = diaSP(new Date());
  const prazo = diaSP(new Date(iso));
  return Math.round(
    (new Date(prazo + "T00:00:00").getTime() - new Date(hoje + "T00:00:00").getTime()) / 86400000,
  );
}

export type PrazoNivel = "vencido" | "hoje" | "amanha" | "proximo" | "ok";

export function nivelPrazo(dias: number | null): PrazoNivel | null {
  if (dias === null) return null;
  if (dias < 0) return "vencido";
  if (dias === 0) return "hoje";
  if (dias === 1) return "amanha";
  if (dias <= 3) return "proximo";
  return "ok";
}

export const PRAZO_ESTILO: Record<PrazoNivel, string> = {
  vencido: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800",
  hoje: "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-800",
  amanha: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800",
  proximo: "bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-950/30 dark:text-yellow-300 dark:border-yellow-900",
  ok: "bg-muted text-muted-foreground border-transparent",
};

export function fmtPrazoData(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit",
  });
}

// ============================================================================
// Peso/volume do produto extraído do NOME. `produtos` não tem coluna de peso
// (o Tiny não é sincronizado nesse campo), e na bancada produtos que só
// diferem no peso têm foto e nome quase iguais ("Areia ... 4kg" × "... 10kg").
// Pega a ÚLTIMA ocorrência de "número + kg/g/ml/l": em nomes de variação o
// peso da variação vem no fim ("2,5 a 15kg - Pêssego l 5 kg" → "5 kg").
// ============================================================================
export interface PesoNome {
  valor: string;   // "4", "2,5", "500"
  unidade: string; // "kg" | "g" | "ml" | "L"
  rotulo: string;  // "4 kg"
  inicio: number;  // posição no nome (p/ destacar o trecho)
  fim: number;
}

const RE_PESO = /(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|lt|litros?)\b/gi;

export function extrairPeso(nome: string | null | undefined): PesoNome | null {
  if (!nome) return null;
  let ultimo: RegExpExecArray | null = null;
  RE_PESO.lastIndex = 0;
  for (let m = RE_PESO.exec(nome); m; m = RE_PESO.exec(nome)) ultimo = m;
  if (!ultimo) return null;
  const valor = ultimo[1];
  const u = ultimo[2].toLowerCase();
  const unidade = u === "kg" ? "kg" : u === "g" ? "g" : u === "ml" ? "ml" : "L";
  return {
    valor, unidade, rotulo: `${valor} ${unidade}`,
    inicio: ultimo.index, fim: ultimo.index + ultimo[0].length,
  };
}
