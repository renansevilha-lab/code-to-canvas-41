/**
 * Storage local em IndexedDB para o módulo ADS.
 * Mesma DB que Vendas, com store separada `ads`.
 * Dedup por chave (id_anuncio + data).
 */

import { openDB, type IDBPDatabase } from "idb";

import type { AdRow } from "./types";

const DB_NAME = "shopee-analytics";
const DB_VERSION = 2; // bump pra adicionar store `ads`

async function getDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (!db.objectStoreNames.contains("pedidos")) {
        const s = db.createObjectStore("pedidos", { keyPath: "id" });
        s.createIndex("data_pedido", "data_pedido");
      }
      if (!db.objectStoreNames.contains("itens")) {
        const s = db.createObjectStore("itens", { autoIncrement: true });
        s.createIndex("id_pedido", "id_pedido");
        s.createIndex("data_pedido", "data_pedido");
        s.createIndex("sku", "sku");
        s.createIndex("composite", ["id_pedido", "sku"], { unique: false });
      }
      if (oldVersion < 2 && !db.objectStoreNames.contains("ads")) {
        const s = db.createObjectStore("ads", { keyPath: "chave" });
        s.createIndex("data", "data");
        s.createIndex("id_anuncio", "id_anuncio");
      }
    },
  });
}

export async function getAllAds(): Promise<AdRow[]> {
  const db = await getDB();
  return (await db.getAll("ads")) as AdRow[];
}

export async function salvarAds(
  rows: AdRow[]
): Promise<{ novos: number; atualizados: number }> {
  if (rows.length === 0) return { novos: 0, atualizados: 0 };
  const db = await getDB();
  const tx = db.transaction("ads", "readwrite");
  const store = tx.objectStore("ads");
  let novos = 0;
  let atualizados = 0;
  for (const r of rows) {
    const exist = await store.get(r.chave);
    if (exist) atualizados++;
    else novos++;
    await store.put(r);
  }
  await tx.done;
  return { novos, atualizados };
}

export async function limparTudoAds(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("ads", "readwrite");
  await tx.objectStore("ads").clear();
  await tx.done;
}

export async function statsAds(): Promise<{
  total_rows: number;
  data_min: string | null;
  data_max: string | null;
}> {
  const db = await getDB();
  const total_rows = await db.count("ads");
  let data_min: string | null = null;
  let data_max: string | null = null;
  if (total_rows > 0) {
    const idx = db.transaction("ads").objectStore("ads").index("data");
    // Pula chaves vazias (rows sem data)
    const range = IDBKeyRange.lowerBound("0");
    const first = await idx.openCursor(range, "next");
    if (first) data_min = String(first.key);
    const last = await idx.openCursor(range, "prev");
    if (last) data_max = String(last.key);
  }
  return { total_rows, data_min, data_max };
}
