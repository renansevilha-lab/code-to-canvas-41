import { getShopeeAnalyticsDB } from "@/lib/storage/db";
import type { CmvRow } from "./types";

export async function getAllCmv(): Promise<CmvRow[]> {
  const db = await getShopeeAnalyticsDB();
  return (await db.getAll("cmv")) as CmvRow[];
}

export async function salvarCmv(
  rows: CmvRow[]
): Promise<{ novos: number; atualizados: number }> {
  if (rows.length === 0) return { novos: 0, atualizados: 0 };
  const db = await getShopeeAnalyticsDB();
  const tx = db.transaction("cmv", "readwrite");
  const store = tx.objectStore("cmv");
  let novos = 0;
  let atualizados = 0;
  for (const r of rows) {
    const existing = await store.get(r.sku);
    if (existing) atualizados++;
    else novos++;
    await store.put(r);
  }
  await tx.done;
  return { novos, atualizados };
}

export async function limparCmv(): Promise<void> {
  const db = await getShopeeAnalyticsDB();
  const tx = db.transaction("cmv", "readwrite");
  await tx.objectStore("cmv").clear();
  await tx.done;
}
