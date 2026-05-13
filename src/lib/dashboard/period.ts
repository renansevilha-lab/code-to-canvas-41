import {
  endOfMonth,
  endOfYesterday,
  format,
  startOfMonth,
  startOfYesterday,
  subDays,
  subMonths,
} from "date-fns";

export type PeriodPreset =
  | "today"
  | "last7"
  | "last30"
  | "mtd"
  | "prev_month"
  | "last90"
  | "custom";

export type PeriodRange = {
  preset: PeriodPreset;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
};

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  today: "Hoje",
  last7: "Últimos 7 dias",
  last30: "Últimos 30 dias",
  mtd: "Mês atual",
  prev_month: "Mês anterior",
  last90: "Últimos 90 dias",
  custom: "Personalizado",
};

// Short label used inside KPI card titles ("Pedidos no mês", "Pedidos hoje", …)
export const PERIOD_SUFFIX: Record<PeriodPreset, string> = {
  today: "hoje",
  last7: "últ. 7 dias",
  last30: "últ. 30 dias",
  mtd: "no mês",
  prev_month: "mês anterior",
  last90: "últ. 90 dias",
  custom: "no período",
};

const fmt = (d: Date) => format(d, "yyyy-MM-dd");

export function computeRange(preset: PeriodPreset, today = new Date()): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: fmt(today), to: fmt(today) };
    case "last7":
      return { from: fmt(subDays(today, 6)), to: fmt(today) };
    case "last30":
      return { from: fmt(subDays(today, 29)), to: fmt(today) };
    case "mtd":
      return { from: fmt(startOfMonth(today)), to: fmt(today) };
    case "prev_month": {
      const prev = subMonths(today, 1);
      return { from: fmt(startOfMonth(prev)), to: fmt(endOfMonth(prev)) };
    }
    case "last90":
      return { from: fmt(subDays(today, 89)), to: fmt(today) };
    case "custom":
      // caller must override
      return { from: fmt(startOfMonth(today)), to: fmt(today) };
  }
}

export function resolveRange(
  preset: PeriodPreset,
  from: string | undefined,
  to: string | undefined,
): PeriodRange {
  if (preset === "custom" && from && to) return { preset, from, to };
  const { from: f, to: t } = computeRange(preset);
  return { preset, from: f, to: t };
}
