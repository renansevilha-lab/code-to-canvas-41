// Formatadores em pt-BR

export function formatBRL(value: number, options?: { compact?: boolean }): string {
  if (!Number.isFinite(value)) return "R$ 0,00";
  if (options?.compact && Math.abs(value) >= 1000) {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return "0%";
  return `${value.toFixed(decimals).replace(".", ",")}%`;
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

export function formatDelta(current: number, previous: number): {
  value: number;
  label: string;
  direction: "up" | "down" | "flat";
} {
  if (!previous) {
    return { value: 0, label: "—", direction: "flat" };
  }
  const delta = ((current - previous) / Math.abs(previous)) * 100;
  return {
    value: delta,
    label: `${delta > 0 ? "+" : ""}${delta.toFixed(1).replace(".", ",")}%`,
    direction: delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat",
  };
}
