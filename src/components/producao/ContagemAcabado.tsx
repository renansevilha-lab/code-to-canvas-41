// Contagem física do produto acabado (04/nov/2026): a base do estoque da Produção pelo nosso sistema.
// Cada contagem vira o novo ponto de partida; depois dela o saldo anda sozinho (lotes encerrados entram,
// vendas do galpão e envios ao Full saem). A conta mora na RPC producao_estoque_acabado.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { usePerfil } from "@/hooks/usePerfil";
import { Botao, Campo, Entrada } from "./ui";
import { erroMsg, int, type EstoqueAcabado } from "@/lib/producao";

const quando = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });

interface Linha { id: number; qtd: number; em: string; por: string | null; obs: string | null }

export function ContagemAcabado({ item, foto, onFechar }: { item: EstoqueAcabado | null; foto?: string; onFechar: () => void }) {
  const qc = useQueryClient();
  const { perfil } = usePerfil();
  const [qtd, setQtd] = useState("");
  const [obs, setObs] = useState("");
  const [salvando, setSalvando] = useState(false);
  useEffect(() => { setQtd(""); setObs(""); }, [item?.sku]);

  const hist = useQuery({
    queryKey: ["producao", "contagens", item?.sku],
    enabled: !!item,
    placeholderData: undefined,
    queryFn: async () => {
      const { data, error } = await supabaseExternal.from("producao_estoque_contagem" as never)
        .select("id, qtd, em, por, obs").eq("sku", item!.sku).order("em", { ascending: false }).limit(8);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as Linha[];
    },
  });

  async function salvar() {
    const n = Number(qtd.trim());
    if (!qtd.trim() || !Number.isInteger(n) || n < 0) return toast.error("Digite quantos sacos há no galpão (número inteiro).");
    setSalvando(true);
    const { error } = await supabaseExternal.from("producao_estoque_contagem" as never).insert({
      sku: item!.sku, qtd: n, por: perfil?.nome ?? null, obs: obs.trim() || null,
    } as never);
    setSalvando(false);
    if (error) return toast.error(erroMsg(error));
    toast.success(`Contagem de ${int(n)} gravada. O estoque passa a contar daqui.`);
    await qc.invalidateQueries({ queryKey: ["producao"] });
    onFechar();
  }

  async function apagar(l: Linha) {
    if (!window.confirm(`Apagar a contagem de ${int(l.qtd)} (${quando(l.em)})? O estoque volta a partir da contagem anterior.`)) return;
    const { error } = await supabaseExternal.from("producao_estoque_contagem" as never).delete().eq("id", l.id);
    if (error) return toast.error(erroMsg(error));
    await qc.invalidateQueries({ queryKey: ["producao"] });
  }

  const sub = { fontSize: 12, color: "var(--pm-t3)" } as const;
  return (
    <Dialog open={!!item} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-md" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>Contagem do estoque</DialogTitle></DialogHeader>
        {item && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              {foto && <img src={foto} alt="" width={44} height={44} style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8, border: "1px solid var(--pm-bs)", background: "#fff" }} />}
              <div>
                <div style={{ fontWeight: 700 }}>{item.sku}</div>
                <div style={{ fontSize: 12.5, color: "var(--pm-t2)" }}>{item.nome}</div>
              </div>
            </div>
            <div style={{ fontSize: 13, padding: 10, borderRadius: 9, background: "var(--pm-s2)" }}>
              {item.saldo != null ? (
                <>No sistema agora: <b>{int(item.saldo)}</b> no galpão (contagem {int(item.contagem_qtd)} + produzido {int(item.produzido)} − vendido {int(item.vendido_galpao)} − enviado ao Full {int(item.enviado_full)}).</>
              ) : (
                <>Ainda sem contagem. O Tiny diz {int(item.estoque_tiny)} — só como referência.</>
              )}
            </div>
            <Campo rotulo="Sacos no galpão agora" dica="Conte com a fila deste produto já embalada: pedido feito antes da contagem e ainda na prateleira seria descontado de novo.">
              <Entrada inputMode="numeric" autoFocus value={qtd} onChange={(e) => setQtd(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={(e) => { if (e.key === "Enter") void salvar(); }} style={{ height: 48, fontSize: 22, fontWeight: 700, textAlign: "center" }} />
            </Campo>
            <Campo rotulo="Observação (opcional)"><Entrada value={obs} onChange={(e) => setObs(e.target.value)} /></Campo>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Botao tom="fantasma" onClick={onFechar} disabled={salvando}>Cancelar</Botao>
              <Botao tom="primario" onClick={salvar} disabled={salvando}>{salvando ? "Gravando…" : "Gravar contagem"}</Botao>
            </div>
            {(hist.data ?? []).length > 0 && (
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>Contagens anteriores</div>
                {(hist.data ?? []).map((l, i) => (
                  <div key={l.id} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, padding: "5px 0", borderTop: "1px solid var(--pm-bs)" }}>
                    <b style={{ minWidth: 48, textAlign: "right" }}>{int(l.qtd)}</b>
                    <span style={sub}>{quando(l.em)}{l.por ? ` · ${l.por}` : ""}{l.obs ? ` · ${l.obs}` : ""}{i === 0 ? " · vale esta" : ""}</span>
                    <div style={{ flex: 1 }} />
                    <Botao tom="fantasma" onClick={() => apagar(l)} style={{ height: 26, fontSize: 12 }}>apagar</Botao>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
