import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { BarraAbas } from "@/components/separacao/ui/kit";
import { Painel } from "@/components/producao/Painel";
import { Entradas } from "@/components/producao/Entradas";
import { AbrirLote } from "@/components/producao/AbrirLote";
import { ChaoFabrica } from "@/components/producao/ChaoFabrica";
import { Botao, Entrada } from "@/components/producao/ui";

// ============================================================================
// Produção (27/out/2026) — envase da areia Bumi (16581 grãos médios, 16678 grossa)
// a partir da farinha em big bag. 1 lote = 1 big bag. Regra toda no banco
// (docs/producao-mvp.sql): producao_abrir_lote / producao_encerrar_lote e as views
// view_producao_lote, view_producao_big_bag, view_producao_estoque.
// ?lote=<id> abre o chão de fábrica (tela do celular da bancada).
// ============================================================================

type Aba = "painel" | "entradas";
interface Busca { aba: Aba; lote?: number }

export const Route = createFileRoute("/producao")({
  validateSearch: (s: Record<string, unknown>): Busca => ({
    aba: s.aba === "entradas" ? "entradas" : "painel",
    lote: Number(s.lote) > 0 ? Number(s.lote) : undefined,
  }),
  component: ProducaoPage,
});

function ProducaoPage() {
  const busca = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [abrindo, setAbrindo] = useState(false);
  const [rastreio, setRastreio] = useState("");

  const ir = (b: Partial<Busca>) => navigate({ search: (s: Busca) => ({ ...s, ...b }), resetScroll: false });
  const irLote = (id: number | undefined) => navigate({ search: (s: Busca) => ({ ...s, lote: id }) });

  async function rastrear() {
    const q = rastreio.trim().toUpperCase();
    if (!q) return;
    const { data, error } = await supabaseExternal.from("producao_ordem" as never).select("id, codigo")
      .ilike("codigo", `%${q}%`).order("inicio_em", { ascending: false }).limit(1);
    const achado = (data as unknown as Array<{ id: number }> | null)?.[0];
    if (error || !achado) return toast.error(error ? error.message : `Nenhum lote com "${q}".`);
    setRastreio("");
    irLote(achado.id);
  }

  return (
    <div className="pm-ui" style={{ display: "flex", flexDirection: "column", gap: 14, color: "var(--pm-t)", fontSize: 13, paddingBottom: 40 }}>
      {busca.lote ? (
        <ChaoFabrica id={busca.lote} onVoltar={() => irLote(undefined)} />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Produção</h1>
            <div style={{ flex: 1 }} />
            <div style={{ display: "flex", gap: 6 }}>
              <Entrada value={rastreio} onChange={(e) => setRastreio(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void rastrear(); }}
                placeholder="Código do lote (rastrear)" style={{ width: 210 }} />
              <Botao onClick={rastrear}>Buscar</Botao>
            </div>
          </div>
          <BarraAbas
            ativa={busca.aba}
            abas={[
              { id: "painel", nome: "Painel do dia", onClick: () => ir({ aba: "painel" }) },
              { id: "entradas", nome: "Entradas de matéria-prima", onClick: () => ir({ aba: "entradas" }) },
            ]}
          />
          {busca.aba === "painel"
            ? <Painel onAbrirLote={() => setAbrindo(true)} onIrLote={irLote} onIrEntradas={() => ir({ aba: "entradas" })} />
            : <Entradas />}
        </>
      )}
      <AbrirLote aberto={abrindo} onFechar={() => setAbrindo(false)} onAberto={(id) => { setAbrindo(false); irLote(id); }} />
    </div>
  );
}
