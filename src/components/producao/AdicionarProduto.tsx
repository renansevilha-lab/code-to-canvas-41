// Adicionar um produto à Produção (05/nov/2026, pedido do dono): escolhe um produto do catálogo e cria a ficha
// copiando a de um produto parecido (farinha, embalagem, peso, pesagem…). Depois abre o "Editar ficha" para ajustar.
// Grava direto em producao_parametros (RLS: só quem tem o módulo "todos"). Produto com ficha desligada = religa.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Botao, Campo, Entrada, Escolha, Selo } from "./ui";
import { erroMsg } from "@/lib/producao";

interface ProdutoCat { sku: string; nome: string | null; tipo: string | null }
interface FichaExistente { sku: string; prefixo_lote: string; ativo: boolean; [k: string]: unknown }

// campos copiados da ficha modelo (o resto — sku, prefixo, meta, processo — é do produto novo)
const COPIAR = [
  "farinha_id", "embalagem_padrao_id", "peso_nominal_kg", "sobrepeso_pct", "perda_pct", "tolerancia_g", "custo_insumo_kg",
  "pesar_cada", "pesar_primeiros", "mistura_insumo_id", "mistura_un_kg", "mistura_farinha_kg", "seladora_temp_c",
] as const;

export function AdicionarProduto({ aberto, onFechar, onCriado }: { aberto: boolean; onFechar: () => void; onCriado: (sku: string) => void }) {
  const qc = useQueryClient();
  const [busca, setBusca] = useState("");
  const [termo, setTermo] = useState("");
  const [escolhido, setEscolhido] = useState<ProdutoCat | null>(null);
  const [modelo, setModelo] = useState("");
  const [prefixo, setPrefixo] = useState("");
  const [salvando, setSalvando] = useState(false);

  useEffect(() => { if (!aberto) { setBusca(""); setTermo(""); setEscolhido(null); setPrefixo(""); } }, [aberto]);
  useEffect(() => { const t = setTimeout(() => setTermo(busca.trim()), 350); return () => clearTimeout(t); }, [busca]);

  const fichas = useQuery({
    queryKey: ["producao", "fichas-todas"],
    enabled: aberto,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("producao_parametros" as never).select("*").order("sku");
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as FichaExistente[];
    },
  });
  const nomes = useQuery({
    queryKey: ["producao", "fichas-nomes", (fichas.data ?? []).map((f) => f.sku).join(",")],
    enabled: aberto && !!fichas.data?.length,
    queryFn: async () => {
      const { data } = await supabaseExternal.from("produtos").select("sku, nome").in("sku", fichas.data!.map((f) => f.sku));
      return Object.fromEntries(((data ?? []) as Array<{ sku: string; nome: string }>).map((p) => [p.sku, p.nome])) as Record<string, string>;
    },
  });
  useEffect(() => { if (!modelo && fichas.data?.length) setModelo(fichas.data.find((f) => f.ativo)?.sku ?? fichas.data[0].sku); }, [fichas.data, modelo]);

  const resultados = useQuery({
    queryKey: ["producao", "busca-produto", termo],
    enabled: aberto && termo.length >= 2,
    placeholderData: undefined,
    queryFn: async () => {
      const t = termo.replace(/[%,()]/g, " ").trim();
      const { data, error } = await supabaseExternal.from("produtos").select("sku, nome, tipo")
        .eq("ativo", true).or(`sku.ilike.${t}%,nome.ilike.%${t.split(/\s+/).join("%")}%`).order("sku").limit(25);
      if (error) throw new Error(error.message);
      return ((data ?? []) as unknown as ProdutoCat[]).filter((p) => p.tipo !== "K" && p.tipo !== "V");
    },
  });

  const existente = escolhido ? fichas.data?.find((f) => f.sku === escolhido.sku) : undefined;

  function escolher(p: ProdutoCat) {
    setEscolhido(p);
    setPrefixo(p.sku);
  }

  async function criar() {
    if (!escolhido) return;
    setSalvando(true);
    try {
      if (existente) {
        if (!existente.ativo) {
          const { error } = await supabaseExternal.from("producao_parametros" as never).update({ ativo: true, updated_at: new Date().toISOString() } as never).eq("sku", escolhido.sku);
          if (error) throw error;
          toast.success("Ficha religada.");
        }
      } else {
        const m = fichas.data?.find((f) => f.sku === modelo);
        if (!m) return toast.error("Escolha de qual produto copiar a ficha.");
        const pref = prefixo.trim().toUpperCase();
        if (!pref) return toast.error("Informe o prefixo do lote.");
        if (fichas.data?.some((f) => f.prefixo_lote.toUpperCase() === pref)) return toast.error(`O prefixo ${pref} já é de outro produto.`);
        const linha: Record<string, unknown> = { sku: escolhido.sku, prefixo_lote: pref, ativo: true, processo: [] };
        for (const k of COPIAR) linha[k] = m[k] ?? null;
        const { error } = await supabaseExternal.from("producao_parametros" as never).insert(linha as never);
        if (error) throw error;
        toast.success(`${escolhido.sku} entrou na Produção. Confira a ficha.`);
      }
      await qc.invalidateQueries({ queryKey: ["producao"] });
      onCriado(escolhido.sku);
    } catch (e) {
      toast.error(erroMsg(e as { message: string }));
    } finally {
      setSalvando(false);
    }
  }

  const sub = { fontSize: 12, color: "var(--pm-t3)" } as const;
  return (
    <Dialog open={aberto} onOpenChange={(v) => { if (!v) onFechar(); }}>
      <DialogContent className="pm-ui max-w-xl" style={{ background: "var(--pm-s)", color: "var(--pm-t)", maxHeight: "90vh", overflowY: "auto" }}>
        <DialogHeader><DialogTitle>Adicionar produto à Produção</DialogTitle></DialogHeader>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {!escolhido ? (
            <>
              <Campo rotulo="Produto" dica="SKU ou parte do nome; kits e produtos com variações ficam de fora">
                <Entrada autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="ex.: 15984 ou areia mandioca 4kg" />
              </Campo>
              {termo.length >= 2 && (
                <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--pm-b)", borderRadius: 10, overflow: "hidden" }}>
                  {resultados.isLoading && <div style={{ ...sub, padding: 10 }}>Procurando…</div>}
                  {resultados.error && <div style={{ fontSize: 12, color: "var(--pm-r)", padding: 10 }}>{(resultados.error as Error).message}</div>}
                  {resultados.data && !resultados.data.length && <div style={{ ...sub, padding: 10 }}>Nenhum produto ativo encontrado.</div>}
                  {(resultados.data ?? []).map((p) => {
                    const f = fichas.data?.find((x) => x.sku === p.sku);
                    return (
                      <button key={p.sku} type="button" onClick={() => escolher(p)} className="pm-linha-hv"
                        style={{ textAlign: "left", padding: "8px 10px", border: 0, borderBottom: "1px solid var(--pm-b)", background: "transparent", color: "var(--pm-t)", cursor: "pointer", display: "flex", gap: 8, alignItems: "center" }}>
                        <b style={{ minWidth: 56 }}>{p.sku}</b>
                        <span style={{ fontSize: 13, flex: 1 }}>{p.nome}</span>
                        {f && <Selo tom={f.ativo ? "g" : "a"}>{f.ativo ? "já na produção" : "ficha desligada"}</Selo>}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <b>{escolhido.sku}</b>
                  <div style={{ fontSize: 13, color: "var(--pm-t2)" }}>{escolhido.nome}</div>
                </div>
                <Botao tom="fantasma" onClick={() => setEscolhido(null)}>trocar</Botao>
              </div>
              {existente ? (
                <p style={{ margin: 0, fontSize: 13 }}>
                  {existente.ativo ? "Este produto já está na Produção." : "Este produto já tem ficha, mas ela está desligada. Religar faz ele voltar ao “O que produzir”."}
                </p>
              ) : (
                <>
                  <Campo rotulo="Copiar a ficha de" dica="farinha, mistura, embalagem, peso, tolerância, pesagem e seladora; depois dá para ajustar tudo">
                    <Escolha value={modelo} onChange={(e) => setModelo(e.target.value)}>
                      {(fichas.data ?? []).map((f) => (
                        <option key={f.sku} value={f.sku}>{f.sku} — {nomes.data?.[f.sku] ?? f.prefixo_lote}{f.ativo ? "" : " (desligada)"}</option>
                      ))}
                    </Escolha>
                  </Campo>
                  <Campo rotulo="Prefixo do lote" dica="aparece no código do lote: PREFIXO-AAAAMMDD-NN">
                    <Entrada value={prefixo} onChange={(e) => setPrefixo(e.target.value)} />
                  </Campo>
                </>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <Botao tom="fantasma" onClick={onFechar} disabled={salvando}>Cancelar</Botao>
                {existente?.ativo ? (
                  <Botao tom="primario" onClick={() => onCriado(escolhido.sku)}>Abrir a ficha</Botao>
                ) : (
                  <Botao tom="primario" onClick={criar} disabled={salvando || (!existente && !fichas.data?.length)}>
                    {salvando ? "Gravando…" : existente ? "Religar a ficha" : "Adicionar e editar a ficha"}
                  </Botao>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
