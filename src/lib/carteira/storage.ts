import { getShopeeAnalyticsDB } from "@/lib/storage/db";
import type { TransacaoCarteira } from "./types";

export async function getAllCarteira(): Promise<TransacaoCarteira[]> {
  const db = await getShopeeAnalyticsDB();
  return (await db.getAll("carteira")) as TransacaoCarteira[];
}

export async function salvarCarteira(
  rows: TransacaoCarteira[]
): Promise<{ novos: number; atualizados: number }> {
  if (rows.length === 0) return { novos: 0, atualizados: 0 };
  const db = await getShopeeAnalyticsDB();
  const tx = db.transaction("carteira", "readwrite");
  const store = tx.objectStore("carteira");
  let novos = 0;
  let atualizados = 0;
  for (const r of rows) {
    const existing = await store.get(r.chave);
    if (existing) atualizados++;
    else novos++;
    await store.put(r);
  }
  await tx.done;
  return { novos, atualizados };
}

export async function limparCarteira(): Promise<void> {
  const db = await getShopeeAnalyticsDB();
  const tx = db.transaction("carteira", "readwrite");
  await tx.objectStore("carteira").clear();
  await tx.done;
}
