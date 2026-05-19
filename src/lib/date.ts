// Utilities for São Paulo (GMT-3, no DST since 2019) timezone-aware date ranges.
// Use these whenever comparing against timestamptz columns in Supabase
// (data_pedido, data_pagamento_shopee, transacoes_carteira.data, etc).
//
// All "start/end of day in SP" helpers return ISO strings in UTC, ready
// to send to Supabase via .gte/.lte.

const SP_OFFSET_HOURS = 3; // SP = UTC-3

/** Returns YYYY-MM-DD of `date` as it would read on a São Paulo wall clock. */
export function toSPDateKey(date: Date = new Date()): string {
  // en-CA format: YYYY-MM-DD
  return date.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Start of day in SP for a "YYYY-MM-DD" key, as ISO UTC. */
export function inicioDoDiaSPFromKey(key: string): string {
  // 00:00 SP == 03:00 UTC same calendar day
  return `${key}T03:00:00.000Z`;
}

/** End of day in SP for a "YYYY-MM-DD" key, as ISO UTC. */
export function fimDoDiaSPFromKey(key: string): string {
  const start = new Date(inicioDoDiaSPFromKey(key)).getTime();
  return new Date(start + 86_400_000 - 1).toISOString();
}

/** Start of day in SP for a Date instance, as ISO UTC. */
export function inicioDoDiaSP(date: Date = new Date()): string {
  return inicioDoDiaSPFromKey(toSPDateKey(date));
}

/** End of day in SP for a Date instance, as ISO UTC. */
export function fimDoDiaSP(date: Date = new Date()): string {
  return fimDoDiaSPFromKey(toSPDateKey(date));
}

/**
 * Converts a {from, to} pair of "YYYY-MM-DD" keys (as used by PeriodRange)
 * into ISO UTC timestamps anchored to São Paulo day boundaries.
 */
export function rangeToSPIso(from: string, to: string): { fromIso: string; toIso: string } {
  return {
    fromIso: inicioDoDiaSPFromKey(from),
    toIso: fimDoDiaSPFromKey(to),
  };
}

// Suppress unused-export warning while keeping the constant documented.
void SP_OFFSET_HOURS;
