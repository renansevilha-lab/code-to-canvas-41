// "Lançar no sistema" (10/nov/2026, pedido do dono): o custo variável do cenário vira o custo que o resto do app usa.
// Vai como CUSTO MANUAL VIGENTE (cmv_manual) pela RPC producao_lancar_custo → reprocessar_cmv_periodo: Pedidos
// Integrados/DRE (pedidos desde a data escolhida são recongelados; kits que levam o produto também) e Promoções
// (promo_mc_base / flashsale_mc_base leem cmv_na_data de hoje). O custo do Tiny não muda. SQL em docs/producao-lancar-custo.sql.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { brl } from "@/lib/producao";
import type { CustoSku } from "@/lib/custos";
import { Botao, Entrada } from "../ui";

export interface CmvSistema {
  sku: string; cmv_hoje: number | null; origem: "manual" | "kit" | "cadastro"; manual_desde: string | null;
  manual_custo: number | null; custo_cadastro: number | null; kits_que_usam: number;
}

export function useCmvSistema(skus: string[]) {
  const chave = [...skus].sort().join(",");
  return useQuery({
    queryKey: ["producao", "cmv-sistema", chave],
    enabled: skus.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, CmvSistema>> => {
      const { data, error } = await supabaseExternal.rpc("producao_cmv_sistema" as never, { p_skus: skus } as never);
      if (error) throw error;
      return Object.fromEntries(((data ?? []) as unknown as CmvSistema[]).map((r) => [r.sku, { ...r, cmv_hoje: r.cmv_hoje == null ? null : Number(r.cmv_hoje) }]));
    },
  });
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const diferente = (c: CustoSku, s?: CmvSistema) => !!s && (s.cmv_hoje == null || Math.abs(r2(c.cv) - r2(s.cmv_hoje)) >= 0.01);
const dataBR = (d: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "");
const hojeBRT = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);

/** O custo que o sistema usa hoje, com o botão de lançar o do cenário quando é diferente. */
export function CustoNoSistema({ c, s, carregando, onLancar, compacto }: { c: CustoSku; s?: CmvSistema; carregando: boolean; onLancar: () => void; compacto?: boolean }) {
  if (carregando && !s) return <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>…</span>;
  if (!s) return <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>—</span>;
  const dif = diferente(c, s);
  const origem = s.origem === "manual" ? `lançado desde ${dataBR(s.manual_desde)}` : s.origem === "kit" ? "pela composição" : "do Tiny";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-end", flexWrap: compacto ? "nowrap" : "wrap" }}>
      <span style={{ textAlign: "right" }}>
        <b style={{ fontVariantNumeric: "tabular-nums", color: dif ? "var(--pm-am)" : "var(--pm-g)" }}>{s.cmv_hoje == null ? "sem custo" : brl(s.cmv_hoje)}</b>
        <span style={{ display: "block", fontSize: 10.5, color: "var(--pm-t3)", whiteSpace: "nowrap" }}>{dif ? origem : "igual ao cenário"}</span>
      </span>
      {dif && <Botao tom="secundario" onClick={onLancar} style={{ height: 26, padding: "0 9px", fontSize: 12 }} title={`Lançar ${brl(c.cv)} como custo do ${c.sku}`}>Lançar</Botao>}
    </span>
  );
}

/** Diálogo de lançamento: um ou vários produtos, custo editável, data de início e confirmação. */
export function LancarCustoDialog({ itens, sistema, cenarioNome, onFechar }: {
  itens: CustoSku[] | null; sistema: Record<string, CmvSistema>; cenarioNome: string; onFechar: () => void;
}) {
  const qc = useQueryClient();
  const [marc, setMarc] = useState<Record<string, boolean>>({});
  const [valor, setValor] = useState<Record<string, string>>({});
  const [desde, setDesde] = useState(hojeBRT());
  const [enviando, setEnviando] = useState(false);
  const [feitos, setFeitos] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!itens) return;
    setMarc(Object.fromEntries(itens.map((c) => [c.sku, itens.length === 1 || diferente(c, sistema[c.sku])])));
    setValor(Object.fromEntries(itens.map((c) => [c.sku, r2(c.cv).toFixed(2).replace(".", ",")])));
    setDesde(hojeBRT()); setFeitos({});
  }, [itens]); // eslint-disable-line react-hooks/exhaustive-deps
  const escolhidos = useMemo(() => (itens ?? []).filter((c) => marc[c.sku]), [itens, marc]);
  const num = (s: string) => Number(String(s ?? "").replace(/\./g, "").replace(",", "."));
  const hoje = hojeBRT();

  async function lancar() {
    const lista = escolhidos.map((c) => ({ c, v: num(valor[c.sku]) }));
    const ruim = lista.find((x) => !(x.v > 0));
    if (ruim) return toast.error(`Custo inválido no ${ruim.c.sku}`);
    if (desde > hoje) return toast.error("A data não pode ser no futuro");
    const txt = lista.map((x) => `• ${x.c.sku}: ${sistema[x.c.sku]?.cmv_hoje == null ? "sem custo" : brl(sistema[x.c.sku]!.cmv_hoje!)} → ${brl(x.v)}`).join("\n");
    const kits = lista.reduce((t, x) => t + (sistema[x.c.sku]?.kits_que_usam ?? 0), 0);
    if (!window.confirm(`Lançar como custo do sistema a partir de ${dataBR(desde)}?\n\n${txt}\n\n`
      + `Muda o CMV dos pedidos desde essa data (Pedidos Integrados e DRE)${kits ? ` e dos ${kits} kit(s) que levam esses produtos` : ""}, e o custo usado nas Promoções. O custo do Tiny não muda.`)) return;
    setEnviando(true);
    const res: Record<string, string> = {};
    for (const x of lista) {
      const { data, error } = await supabaseExternal.rpc("producao_lancar_custo" as never, {
        p_sku: x.c.sku, p_custo: x.v, p_desde: desde, p_obs: `custo da produção (cenário ${cenarioNome})`,
      } as never);
      if (error) { res[x.c.sku] = `erro: ${error.message}`; continue; }
      const r = ((data ?? []) as unknown as Array<{ pedidos: number; sem_custo: number }>)[0];
      res[x.c.sku] = `lançado ${brl(x.v)} · ${r?.pedidos ?? 0} pedido(s) recalculado(s)`;
    }
    setFeitos(res);
    setEnviando(false);
    const erros = Object.values(res).filter((t) => t.startsWith("erro")).length;
    if (erros) toast.error(`${erros} não foi(ram) lançado(s) — veja na lista`);
    else toast.success(`${lista.length} custo(s) lançado(s) no sistema`);
    void qc.invalidateQueries();
  }

  return (
    <Dialog open={!!itens} onOpenChange={(v) => !v && !enviando && onFechar()}>
      <DialogContent className="pm-ui max-w-2xl" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>Lançar custo no sistema</DialogTitle></DialogHeader>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
          <p style={{ margin: 0, color: "var(--pm-t2)", fontSize: 12.5 }}>
            O custo vira o CMV usado nos <b>Pedidos Integrados</b>, no <b>DRE</b> e nas <b>Promoções</b> (kits que levam o produto também mudam).
            Pedidos a partir da data escolhida são recalculados. O custo no Tiny não é alterado.
          </p>
          <div style={{ maxHeight: 340, overflowY: "auto", border: "1px solid var(--pm-b)", borderRadius: 9 }}>
            {(itens ?? []).map((c) => {
              const s = sistema[c.sku];
              return (
                <label key={c.sku} style={{ display: "grid", gridTemplateColumns: "22px 1fr 110px 110px", gap: 8, alignItems: "center", padding: "7px 10px", borderBottom: "1px solid var(--pm-b)" }}>
                  <input type="checkbox" checked={!!marc[c.sku]} disabled={enviando} onChange={(e) => setMarc({ ...marc, [c.sku]: e.target.checked })} />
                  <span style={{ minWidth: 0 }}>
                    <b>{c.sku}</b> <span style={{ fontSize: 11.5, color: "var(--pm-t2)" }}>{c.nome}</span>
                    {feitos[c.sku] && <span style={{ display: "block", fontSize: 11.5, color: feitos[c.sku].startsWith("erro") ? "var(--pm-r)" : "var(--pm-g)" }}>{feitos[c.sku]}</span>}
                  </span>
                  <span style={{ textAlign: "right", fontSize: 12, color: "var(--pm-t2)" }}>
                    hoje {s?.cmv_hoje == null ? "sem custo" : brl(s.cmv_hoje)}
                    <span style={{ display: "block", fontSize: 10.5, color: "var(--pm-t3)" }}>{s?.origem === "manual" ? `lançado ${dataBR(s.manual_desde)}` : s?.origem === "kit" ? "composição" : "Tiny"}</span>
                  </span>
                  <Entrada inputMode="decimal" value={valor[c.sku] ?? ""} disabled={enviando} onChange={(e) => setValor({ ...valor, [c.sku]: e.target.value })}
                    style={{ textAlign: "right", height: 30 }} title={`custo variável do cenário: ${brl(c.cv)}`} />
                </label>
              );
            })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>Vale a partir de</span>
            <Entrada type="date" value={desde} max={hoje} disabled={enviando} onChange={(e) => setDesde(e.target.value)} style={{ height: 30, width: 160 }} />
            <span style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>{desde === hoje ? "só os pedidos de hoje em diante" : "os pedidos desde essa data também são recalculados"}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <Botao onClick={onFechar} disabled={enviando}>{Object.keys(feitos).length ? "Fechar" : "Cancelar"}</Botao>
            <Botao tom="primario" onClick={lancar} disabled={enviando || !escolhidos.length}>{enviando ? "Lançando…" : `Lançar ${escolhidos.length} custo(s)`}</Botao>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
