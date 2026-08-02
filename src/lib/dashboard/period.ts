import {
  addDays,
  endOfMonth,
  startOfMonth,
  subDays,
  subMonths,
} from "date-fns";


export type PeriodPreset =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "mtd"
  | "prev_month"
  | "last90"
  // forward-looking
  | "overdue"
  | "next7"
  | "next30"
  | "next60"
  | "next90"
  | "custom";

export type PeriodRange = {
  preset: PeriodPreset;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
};

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  today: "Hoje",
  yesterday: "Ontem",
  last7: "Últimos 7 dias",
  last30: "Últimos 30 dias",
  mtd: "Mês atual",
  prev_month: "Mês anterior",
  last90: "Últimos 90 dias",
  overdue: "Atrasadas",
  next7: "Próximos 7 dias",
  next30: "Próximos 30 dias",
  next60: "Próximos 60 dias",
  next90: "Próximos 90 dias",
  custom: "Personalizado",
};

export const PERIOD_SUFFIX: Record<PeriodPreset, string> = {
  today: "hoje",
  yesterday: "ontem",
  last7: "últ. 7 dias",
  last30: "últ. 30 dias",
  mtd: "no mês",
  prev_month: "mês anterior",
  last90: "últ. 90 dias",
  overdue: "atrasadas",
  next7: "próx. 7 dias",
  next30: "próx. 30 dias",
  next60: "próx. 60 dias",
  next90: "próx. 90 dias",
  custom: "no período",
};

export const BACKWARD_PRESETS: PeriodPreset[] = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "mtd",
  "prev_month",
  "last90",
];

export const FORWARD_PRESETS: PeriodPreset[] = [
  "overdue",
  "today",
  "next7",
  "next30",
  "next60",
  "next90",
];

// Date key (YYYY-MM-DD) on the São Paulo wall clock, regardless of the
// browser's timezone. Prevents UTC drift for "Hoje"/"Ontem"/etc.
const spKey = (d: Date) =>
  d.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });

// Anchor a YYYY-MM-DD key at 12:00 UTC so date-fns arithmetic stays on the
// same calendar day when we re-serialize via toISOString().slice(0,10).
const keyToAnchor = (key: string) => new Date(`${key}T12:00:00Z`);

const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function computeRange(
  preset: PeriodPreset,
  today: Date = keyToAnchor(spKey(new Date())),
): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: fmt(today), to: fmt(today) };
    case "yesterday": {
      const y = subDays(today, 1);
      return { from: fmt(y), to: fmt(y) };
    }
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
    case "overdue":
      return { from: "1900-01-01", to: fmt(subDays(today, 1)) };
    case "next7":
      return { from: fmt(today), to: fmt(addDays(today, 7)) };
    case "next30":
      return { from: fmt(today), to: fmt(addDays(today, 30)) };
    case "next60":
      return { from: fmt(today), to: fmt(addDays(today, 60)) };
    case "next90":
      return { from: fmt(today), to: fmt(addDays(today, 90)) };
    case "custom":
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

export const ALL_PRESETS: PeriodPreset[] = [
  ...BACKWARD_PRESETS,
  ...FORWARD_PRESETS.filter((p) => !BACKWARD_PRESETS.includes(p)),
  "custom",
];
