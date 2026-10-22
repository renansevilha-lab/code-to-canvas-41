import { useSyncExternalStore } from "react";

// Tema claro/escuro do app. As cores dos dois já estão em styles.css (:root e .dark,
// e os tokens --pm-*/--rl-* das telas no design novo); aqui só liga/desliga a classe
// `dark` no <html> e guarda a escolha neste navegador (localStorage "tema").
// O script em __root.tsx (SCRIPT_TEMA) aplica antes da 1ª pintura, para não piscar claro.

export type Tema = "claro" | "escuro";

const CHAVE = "tema";
const ouvintes = new Set<() => void>();

function ler(): Tema {
  if (typeof document === "undefined") return "claro";
  return document.documentElement.classList.contains("dark") ? "escuro" : "claro";
}

function aplicar(t: Tema) {
  const el = document.documentElement;
  el.classList.toggle("dark", t === "escuro");
  el.style.colorScheme = t === "escuro" ? "dark" : "light";
}

export function definirTema(t: Tema) {
  aplicar(t);
  try { localStorage.setItem(CHAVE, t); } catch { /* sem armazenamento: vale só nesta aba */ }
  ouvintes.forEach((f) => f());
}

export function useTema(): [Tema, (t: Tema) => void] {
  const tema = useSyncExternalStore(
    (f) => { ouvintes.add(f); return () => ouvintes.delete(f); },
    ler,
    () => "claro" as Tema,
  );
  return [tema, definirTema];
}

/** Roda no <head> antes do app: aplica o tema salvo sem piscar. */
export const SCRIPT_TEMA =
  `try{if(localStorage.getItem('${CHAVE}')==='escuro'){var e=document.documentElement;e.classList.add('dark');e.style.colorScheme='dark'}}catch(e){}`;
