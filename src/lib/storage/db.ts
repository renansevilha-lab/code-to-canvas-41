import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "shopee-analytics";
const DB_VERSION = 3;

export async function getShopeeAnalyticsDB(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
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
      if (!db.objectStoreNames.contains("ads")) {
        const s = db.createObjectStore("ads", { keyPath: "chave" });
        s.createIndex("data", "data");
        s.createIndex("id_anuncio", "id_anuncio");
      }
      if (!db.objectStoreNames.contains("cmv")) {
        db.createObjectStore("cmv", { keyPath: "sku" });
      }
    },
  });
}
