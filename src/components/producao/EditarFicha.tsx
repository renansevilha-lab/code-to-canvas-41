// Edição da ficha de produção (30/out/2026, pedido do dono): produto, farinha, mistura, embalagem e etiqueta com os
// preços, mão de obra/fábrica e o processo (temperatura da seladora, outros parâmetros, instruções).
// Grava direto nas tabelas (RLS: só quem tem o módulo "todos"); o custo padrão é recalculado pela view_producao_ficha.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Botao, Campo, Entrada, Escolha } from "./ui";
import { erroMsg, useInsumos, type Insumo } from "@/lib/producao";

export interface ParamProcesso { nome: string; valor: string }

interface ParamRow {
  sku: string; farinha_id: number | null; embalagem_padrao_id: number | null; prefixo_lote: string; peso_nominal_kg: number;
  sobrepeso_pct: number; perda_pct: number; tolerancia_g: number; custo_insumo_kg: number; pesar_cada: number | null;
  pesar_primeiros: number; meta_estoque_un: number | null; ativo: boolean; mistura_insumo_id: number | null;
  mistura_un_kg: number | null; mistura_farinha_kg: number | null; seladora_temp_c: number | null;
  processo: ParamProcesso[] | null; instrucoes: string | null;
}
interface Config { id: number; mod_mensal: number; cif_mensal: number; capacidade_normal_un: number }

const txt = (n: number | null | undefined, mult = 1) =>
  n == null ? "" : String(Math.round(Number(n) * mult * 10000) / 10000).replace(".", ",");
const num = (s: string): number | null => {
  const t = s.trim().replace(/\./g, "").replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
// campos de preço/peso aceitam "0,70" e "0.70": aqui o ponto é decimal
const dec = (s: string): number | null => {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

const NOVA = "__nova__";

export function EditarFicha({ sku, onFim }: { sku: string; onFim: () => void }) {
  const qc = useQueryClient();
  const insumos = useInsumos();
  const dados = useQuery({
    queryKey: ["producao", "ficha-edicao", sku],
    placeholderData: undefined,
    gcTime: 0,
    queryFn: async () => {
      const [p, c, todos] = await Promise.all([
        supabaseExternal.from("producao_parametros" as never).select("*").eq("sku", sku).single(),
        supabaseExternal.from("producao_config" as never).select("id, mod_mensal, cif_mensal, capacidade_normal_un").limit(1).single(),
        supabaseExternal.from("producao_parametros" as never).select("sku, embalagem_padrao_id"),
      ]);
      if (p.error) throw new Error(p.error.message);
      if (c.error) throw new Error(c.error.message);
      return {
        p: p.data as unknown as ParamRow,
        cfg: c.data as unknown as Config,
        usos: (todos.data ?? []) as unknown as Array<{ sku: string; embalagem_padrao_id: number | null }>,
      };
    },
  });

  const [f, setF] = useState<Record<string, string>>({});
  const [ativo, setAtivo] = useState(true);
  const [processo, setProcesso] = useState<ParamProcesso[]>([]);
  const [instrucoes, setInstrucoes] = useState("");
  const [etiquetaSim, setEtiquetaSim] = useState(false);
  const [salvando, setSalvando] = useState(false);

  const lista = insumos.data ?? [];
  const porId = useMemo(() => new Map(lista.map((i) => [i.id, i])), [lista]);

  // preenche uma vez quando os dados chegam
  useEffect(() => {
    const d = dados.data;
    if (!d || !insumos.data) return;
    const { p, cfg } = d;
    const emb = p.embalagem_padrao_id != null ? porId.get(p.embalagem_padrao_id) : undefined;
    const etq = emb?.etiqueta_id != null ? porId.get(emb.etiqueta_id) : undefined;
    setF({
      peso: txt(p.peso_nominal_kg), tol: txt(p.tolerancia_g), sobre: txt(p.sobrepeso_pct, 100), perda: txt(p.perda_pct, 100),
      pesarCada: txt(p.pesar_cada), pesarPrim: txt(p.pesar_primeiros), prefixo: p.prefixo_lote ?? "", meta: txt(p.meta_estoque_un),
      farinha: p.farinha_id != null ? String(p.farinha_id) : "", farinhaKg: txt(p.custo_insumo_kg),
      mistura: p.mistura_insumo_id != null ? String(p.mistura_insumo_id) : "", misturaUnKg: txt(p.mistura_un_kg), misturaFarKg: txt(p.mistura_farinha_kg),
      emb: p.embalagem_padrao_id != null ? String(p.embalagem_padrao_id) : "", embPreco: txt(emb?.custo_referencia),
      novaNome: "", etq: emb?.etiqueta_id != null ? String(emb.etiqueta_id) : "", etqPreco: txt(etq?.custo_referencia),
      mod: txt(cfg.mod_mensal), cif: txt(cfg.cif_mensal), cap: txt(cfg.capacidade_normal_un),
      temp: txt(p.seladora_temp_c),
    });
    setAtivo(p.ativo);
    setEtiquetaSim(!!emb?.precisa_etiqueta);
    setProcesso(Array.isArray(p.processo) ? p.processo : []);
    setInstrucoes(p.instrucoes ?? "");
  }, [dados.data, insumos.data, porId]);

  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  // ao trocar a embalagem, o preço e a etiqueta passam a ser os dela
  function trocarEmbalagem(v: string) {
    const emb = porId.get(Number(v));
    const etq = emb?.etiqueta_id != null ? porId.get(emb.etiqueta_id) : undefined;
    setF((x) => ({ ...x, emb: v, embPreco: v === NOVA ? "" : txt(emb?.custo_referencia), etq: emb?.etiqueta_id != null ? String(emb.etiqueta_id) : x.etq, etqPreco: etq ? txt(etq.custo_referencia) : x.etqPreco }));
    if (v !== NOVA) setEtiquetaSim(!!emb?.precisa_etiqueta);
  }
  function trocarEtiqueta(v: string) {
    const etq = porId.get(Number(v));
    setF((x) => ({ ...x, etq: v, etqPreco: txt(etq?.custo_referencia) }));
  }

  if (dados.error) return <p style={{ fontSize: 13, color: "var(--pm-r)" }}>{(dados.error as Error).message}</p>;
  if (!dados.data || !insumos.data || f.peso == null) return <p style={{ fontSize: 13, color: "var(--pm-t3)" }}>Carregando…</p>;
  const d = dados.data!;
  const de = (t: Insumo["tipo"]) => lista.filter((i) => i.tipo === t && (i.ativo || String(i.id) === f.emb || String(i.id) === f.farinha));
  const embId = f.emb === NOVA ? null : Number(f.emb) || null;
  const outrosNoSaco = d.usos.filter((u) => u.embalagem_padrao_id === embId && u.sku !== sku).map((u) => u.sku);
  const etqId = Number(f.etq) || null;
  const outrosNaEtiqueta = d.usos
    .filter((u) => u.sku !== sku && u.embalagem_padrao_id != null && porId.get(u.embalagem_padrao_id)?.etiqueta_id === etqId && porId.get(u.embalagem_padrao_id)?.precisa_etiqueta)
    .map((u) => u.sku);

  async function salvar() {
    const v = {
      peso: dec(f.peso), tol: num(f.tol), sobre: dec(f.sobre), perda: dec(f.perda), pesarCada: num(f.pesarCada), pesarPrim: num(f.pesarPrim),
      meta: num(f.meta), farinhaKg: dec(f.farinhaKg), misturaUnKg: dec(f.misturaUnKg), misturaFarKg: dec(f.misturaFarKg),
      embPreco: dec(f.embPreco), etqPreco: dec(f.etqPreco), mod: num(f.mod), cif: num(f.cif), cap: num(f.cap), temp: dec(f.temp),
    };
    const ruim = Object.entries(v).find(([, n]) => Number.isNaN(n));
    if (ruim) return toast.error("Há um número que não deu para ler. Use só dígitos e vírgula.");
    if (!v.peso || v.peso <= 0) return toast.error("Informe o peso no saco.");
    if (v.tol == null || v.tol < 0) return toast.error("Informe a tolerância em gramas.");
    if (v.sobre == null || v.perda == null || v.perda >= 100) return toast.error("Confira sobrepeso e perda (em %).");
    if (!f.prefixo.trim()) return toast.error("Informe o prefixo do lote.");
    if (!f.farinha) return toast.error("Escolha a farinha.");
    if (v.farinhaKg == null || v.farinhaKg <= 0) return toast.error("Informe o custo da farinha por kg.");
    if (f.mistura && (!v.misturaUnKg || !v.misturaFarKg)) return toast.error("Na mistura, informe o peso do pacote e a farinha por pacote.");
    if (!f.emb) return toast.error("Escolha a embalagem.");
    if (f.emb === NOVA && !f.novaNome.trim()) return toast.error("Dê um nome à embalagem nova.");
    if (v.embPreco == null || v.embPreco < 0) return toast.error("Informe o preço da embalagem.");
    if (etiquetaSim && !f.etq) return toast.error("Escolha a etiqueta (ou desmarque “leva etiqueta”).");
    if (etiquetaSim && (v.etqPreco == null || v.etqPreco < 0)) return toast.error("Informe o preço da etiqueta.");
    if (!v.mod || !v.cif || !v.cap) return toast.error("Informe mão de obra, custos da fábrica e capacidade.");
    const proc = processo.map((x) => ({ nome: x.nome.trim(), valor: x.valor.trim() })).filter((x) => x.nome || x.valor);

    setSalvando(true);
    try {
      let embalagem = embId;
      const etiqueta = etiquetaSim ? Number(f.etq) : null;
      if (f.emb === NOVA) {
        const { data, error } = await supabaseExternal.from("producao_insumo" as never).insert({
          nome: f.novaNome.trim(), tipo: "embalagem", unidade: "un", custo_referencia: v.embPreco, precisa_etiqueta: etiquetaSim, etiqueta_id: etiqueta,
        } as never).select("id").single();
        if (error) throw error;
        embalagem = (data as unknown as { id: number }).id;
      } else {
        const atual = porId.get(embalagem!);
        if (atual && (Number(atual.custo_referencia) !== v.embPreco || atual.precisa_etiqueta !== etiquetaSim || (etiquetaSim && atual.etiqueta_id !== etiqueta))) {
          const { error } = await supabaseExternal.from("producao_insumo" as never).update({
            custo_referencia: v.embPreco, precisa_etiqueta: etiquetaSim, ...(etiquetaSim ? { etiqueta_id: etiqueta } : {}),
          } as never).eq("id", embalagem!);
          if (error) throw error;
        }
      }
      if (etiquetaSim && etiqueta != null && Number(porId.get(etiqueta)?.custo_referencia) !== v.etqPreco) {
        const { error } = await supabaseExternal.from("producao_insumo" as never).update({ custo_referencia: v.etqPreco } as never).eq("id", etiqueta);
        if (error) throw error;
      }
      if (Number(d.cfg.mod_mensal) !== v.mod || Number(d.cfg.cif_mensal) !== v.cif || Number(d.cfg.capacidade_normal_un) !== v.cap) {
        const { error } = await supabaseExternal.from("producao_config" as never).update({
          mod_mensal: v.mod, cif_mensal: v.cif, capacidade_normal_un: v.cap, updated_at: new Date().toISOString(),
        } as never).eq("id", d.cfg.id);
        if (error) throw error;
      }
      const { error } = await supabaseExternal.from("producao_parametros" as never).update({
        peso_nominal_kg: v.peso, tolerancia_g: v.tol, sobrepeso_pct: v.sobre! / 100, perda_pct: v.perda! / 100,
        pesar_cada: v.pesarCada || null, pesar_primeiros: v.pesarPrim ?? 0, prefixo_lote: f.prefixo.trim().toUpperCase(),
        meta_estoque_un: v.meta, ativo, farinha_id: Number(f.farinha), custo_insumo_kg: v.farinhaKg,
        mistura_insumo_id: f.mistura ? Number(f.mistura) : null, mistura_un_kg: f.mistura ? v.misturaUnKg : null,
        mistura_farinha_kg: f.mistura ? v.misturaFarKg : null, embalagem_padrao_id: embalagem,
        seladora_temp_c: v.temp, processo: proc, instrucoes: instrucoes.trim() || null, updated_at: new Date().toISOString(),
      } as never).eq("sku", sku);
      if (error) throw error;
      toast.success("Ficha salva. O custo padrão foi recalculado.");
      await qc.invalidateQueries({ queryKey: ["producao"] });
      onFim();
    } catch (e) {
      toast.error(erroMsg(e as { message: string }));
    } finally {
      setSalvando(false);
    }
  }

  const grade = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 } as const;
  const bloco = (titulo: string, aviso?: string | null) => (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 700 }}>{titulo}</div>
      {aviso && <div style={{ fontSize: 11.5, color: "var(--pm-am)", marginTop: 2 }}>{aviso}</div>}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {bloco("Produto")}
      <div style={grade}>
        <Campo rotulo="Peso no saco (kg)"><Entrada inputMode="decimal" value={f.peso} onChange={set("peso")} /></Campo>
        <Campo rotulo="Tolerância (g)" dica="mínimo = peso − tolerância"><Entrada inputMode="numeric" value={f.tol} onChange={set("tol")} /></Campo>
        <Campo rotulo="Sobrepeso (%)"><Entrada inputMode="decimal" value={f.sobre} onChange={set("sobre")} /></Campo>
        <Campo rotulo="Perda (%)"><Entrada inputMode="decimal" value={f.perda} onChange={set("perda")} /></Campo>
        <Campo rotulo="Pesar 1 a cada" dica="vazio = pesar todos"><Entrada inputMode="numeric" value={f.pesarCada} onChange={set("pesarCada")} /></Campo>
        <Campo rotulo="Pesar os primeiros"><Entrada inputMode="numeric" value={f.pesarPrim} onChange={set("pesarPrim")} /></Campo>
        <Campo rotulo="Prefixo do lote"><Entrada value={f.prefixo} onChange={set("prefixo")} /></Campo>
        <Campo rotulo="Meta de estoque (un)"><Entrada inputMode="numeric" value={f.meta} onChange={set("meta")} /></Campo>
      </div>
      <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} /> Ficha ligada (aparece em “O que produzir” e no Iniciar produção)
      </label>

      {bloco("Farinha do big bag")}
      <div style={grade}>
        <Campo rotulo="Farinha">
          <Escolha value={f.farinha} onChange={set("farinha")}>
            <option value="">—</option>
            {de("farinha").map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
          </Escolha>
        </Campo>
        <Campo rotulo="Custo padrão (R$/kg)" dica="o custo real do lote vem do big bag usado"><Entrada inputMode="decimal" value={f.farinhaKg} onChange={set("farinhaKg")} /></Campo>
      </div>

      {bloco("Mistura (produto do Tiny)")}
      <div style={grade}>
        <Campo rotulo="Produto misturado">
          <Escolha value={f.mistura} onChange={set("mistura")}>
            <option value="">sem mistura (só farinha)</option>
            {de("produto").map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
          </Escolha>
        </Campo>
        {f.mistura && <Campo rotulo="Peso do pacote (kg)"><Entrada inputMode="decimal" value={f.misturaUnKg} onChange={set("misturaUnKg")} /></Campo>}
        {f.mistura && <Campo rotulo="Farinha por pacote (kg)" dica="define a proporção"><Entrada inputMode="decimal" value={f.misturaFarKg} onChange={set("misturaFarKg")} /></Campo>}
      </div>
      {f.mistura && <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>O preço do pacote é o custo do produto no Tiny (muda lá).</div>}

      {bloco("Embalagem e etiqueta", outrosNoSaco.length ? `O preço e a etiqueta são do saco: valem também para ${outrosNoSaco.join(", ")}.` : null)}
      <div style={grade}>
        <Campo rotulo="Embalagem usada">
          <Escolha value={f.emb} onChange={(e) => trocarEmbalagem(e.target.value)}>
            <option value="">—</option>
            {de("embalagem").map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
            <option value={NOVA}>+ nova embalagem…</option>
          </Escolha>
        </Campo>
        {f.emb === NOVA && <Campo rotulo="Nome da embalagem nova"><Entrada value={f.novaNome} onChange={set("novaNome")} placeholder="ex.: Saco 3 kg impresso" /></Campo>}
        <Campo rotulo="Preço da embalagem (R$/un)"><Entrada inputMode="decimal" value={f.embPreco} onChange={set("embPreco")} /></Campo>
      </div>
      <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
        <input type="checkbox" checked={etiquetaSim} onChange={(e) => setEtiquetaSim(e.target.checked)} /> Esta embalagem leva etiqueta
      </label>
      {etiquetaSim && (
        <>
          <div style={grade}>
            <Campo rotulo="Etiqueta">
              <Escolha value={f.etq} onChange={(e) => trocarEtiqueta(e.target.value)}>
                <option value="">—</option>
                {de("etiqueta").map((i) => <option key={i.id} value={i.id}>{i.nome}</option>)}
              </Escolha>
            </Campo>
            <Campo rotulo="Preço da etiqueta (R$/un)"><Entrada inputMode="decimal" value={f.etqPreco} onChange={set("etqPreco")} /></Campo>
          </div>
          {outrosNaEtiqueta.length > 0 && <div style={{ fontSize: 11.5, color: "var(--pm-am)" }}>O preço da etiqueta vale também para {outrosNaEtiqueta.join(", ")}.</div>}
        </>
      )}

      {bloco("Mão de obra e fábrica", "Vale para todos os produtos: custo por saco = (mão de obra + custos da fábrica) ÷ capacidade.")}
      <div style={grade}>
        <Campo rotulo="Mão de obra no mês (R$)"><Entrada inputMode="decimal" value={f.mod} onChange={set("mod")} /></Campo>
        <Campo rotulo="Custos da fábrica no mês (R$)" dica="aluguel, energia, manutenção…"><Entrada inputMode="decimal" value={f.cif} onChange={set("cif")} /></Campo>
        <Campo rotulo="Capacidade normal (sacos/mês)"><Entrada inputMode="numeric" value={f.cap} onChange={set("cap")} /></Campo>
      </div>

      {bloco("Processo")}
      <div style={grade}>
        <Campo rotulo="Temperatura da seladora (°C)"><Entrada inputMode="decimal" value={f.temp} onChange={set("temp")} /></Campo>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--pm-t2)" }}>Outros parâmetros</div>
      {processo.map((x, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
          <Entrada placeholder="ex.: Tempo de selagem" value={x.nome} onChange={(e) => setProcesso((l) => l.map((y, j) => (j === i ? { ...y, nome: e.target.value } : y)))} />
          <Entrada placeholder="ex.: 2 s" value={x.valor} onChange={(e) => setProcesso((l) => l.map((y, j) => (j === i ? { ...y, valor: e.target.value } : y)))} />
          <Botao tom="fantasma" onClick={() => setProcesso((l) => l.filter((_, j) => j !== i))}>tirar</Botao>
        </div>
      ))}
      <div><Botao onClick={() => setProcesso((l) => [...l, { nome: "", valor: "" }])}>+ parâmetro</Botao></div>
      <Campo rotulo="Instruções para a equipe">
        <textarea value={instrucoes} onChange={(e) => setInstrucoes(e.target.value)} rows={3}
          style={{ padding: 10, borderRadius: 9, border: "1px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", fontSize: 13.5, resize: "vertical" }} />
      </Campo>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6 }}>
        <Botao tom="fantasma" onClick={onFim} disabled={salvando}>Cancelar</Botao>
        <Botao tom="primario" onClick={salvar} disabled={salvando}>{salvando ? "Salvando…" : "Salvar ficha"}</Botao>
      </div>
      <p style={{ fontSize: 11.5, color: "var(--pm-t3)", margin: 0 }}>Lotes já abertos ou encerrados não mudam: valem para os próximos.</p>
    </div>
  );
}
