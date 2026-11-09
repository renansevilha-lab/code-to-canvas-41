// Custo variável por unidade de cada produto fabricado, no cenário escolhido.
// O número vem de custo_cenario_calcular (banco). Editar um campo grava em custo_cenario_sku e o banco recalcula.
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Botao, Campo, Cartao, Entrada, Escolha, Selo, tabela, td, th } from "../ui";
import { brl, int, kg, useFotos } from "@/lib/producao";
import { Produtividade } from "./Produtividade";
import {
  FONTE_KG, FONTE_MOD, FONTE_PRECO_KG, num, pct, salvarSku, salvarSkus, useCenarioSkus, useCusto, useMedicoes, useRecalcular,
  type Cenario, type CenarioSku, type CustoSku,
} from "@/lib/custos";

const CORES = { materia: "#8B6F47", embalagem: "#5B8DEF", mod: "#E0A030", premio: "#9C6ADE", cif: "#7A8699" };

export function PainelCusto({ cenario }: { cenario: Cenario }) {
  const custo = useCusto(cenario.id);
  const skus = useCenarioSkus(cenario.id);
  const fotos = useFotos((custo.data ?? []).map((c) => c.sku));
  const [aberto, setAberto] = useState<string | null>(null);
  const linhas = custo.data ?? [];
  const porSku = useMemo(() => Object.fromEntries((skus.data ?? []).map((s) => [s.sku, s])), [skus.data]);
  const med = useMedicoes();
  // produtividade de cada produto (lotes limpos, view_custo_mod_medida): a do próprio SKU ou, sem lote limpo, a do grupo
  const prod = useMemo(() => {
    const m = med.data?.mod ?? [];
    const grupo = (c: CustoSku) => m.find((x) => x.sku == null && (c.mistura ? x.grupo === "Misturas" : x.grupo.startsWith("Mandioca pura " + String(Number(c.peso_nominal_kg)).replace(".", ","))));
    return Object.fromEntries(linhas.map((c) => {
      const proprio = m.find((x) => x.sku === c.sku);
      return [c.sku, proprio ? { ...proprio, do_grupo: false } : grupo(c) ? { ...grupo(c)!, do_grupo: true } : null];
    }));
  }, [med.data, linhas]);

  if (custo.isLoading) return <Cartao><span style={{ color: "var(--pm-t3)" }}>Calculando…</span></Cartao>;
  if (custo.error) return <Cartao><span style={{ color: "var(--pm-r)" }}>Não deu para calcular: {(custo.error as Error).message}</span></Cartao>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Produtividade />
      <AcoesEmMassa cenario={cenario} linhas={linhas} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 12 }}>
        {linhas.map((c) => (
          <CartaoSku key={c.sku} c={c} foto={fotos.data?.[c.sku]} aberto={aberto === c.sku}
            onAbrir={() => setAberto(aberto === c.sku ? null : c.sku)} cfg={porSku[c.sku]} pronto={!!skus.data} cenario={cenario} prod={prod[c.sku]} />
        ))}
      </div>
      <Legenda />
      <MaoDeObra />
      <MateriaPrima />
    </div>
  );
}

function Legenda() {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: "var(--pm-t2)" }}>
      {[["materia", "Matéria-prima"], ["embalagem", "Embalagem + etiqueta"], ["mod", "Mão de obra"], ["premio", "Prêmio por lote"], ["cif", "Indireto (CIF)"]].map(([k, n]) => (
        <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: CORES[k as keyof typeof CORES] }} />{n}
        </span>
      ))}
    </div>
  );
}

function CartaoSku({ c, foto, aberto, onAbrir, cfg, pronto, cenario, prod }: { c: CustoSku; foto?: string; aberto: boolean; onAbrir: () => void; cfg?: CenarioSku; pronto: boolean; cenario: Cenario;
  prod?: { un_h_linha: number; un_homem_hora: number; lotes: number; un_total: number; do_grupo: boolean } | null }) {
  const partes = [
    { k: "materia", v: c.materia }, { k: "embalagem", v: c.embalagem + c.etiqueta }, { k: "mod", v: c.mod ?? 0 },
    { k: "premio", v: c.premio ?? 0 }, { k: "cif", v: c.cif ?? 0 },
  ];
  const total = partes.reduce((s, p) => s + p.v, 0) || 1;
  const fonteKg = c.kg_un_fonte;
  const tomKg = fonteKg === "medido" ? "g" : fonteKg === "manual" ? "azul" : fonteKg === "padrao_sem_medida" ? "a" : "n";
  return (
    <section style={{ background: "var(--pm-s)", border: `1px solid ${c.alerta_desperdicio ? "var(--pm-r)" : "var(--pm-bs)"}`, borderRadius: 14, padding: 14, boxShadow: "var(--pm-sh)", display: "flex", flexDirection: "column", gap: 10, gridColumn: aberto ? "1 / -1" : undefined }}>
      <header style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        {foto ? <img src={foto} alt="" style={{ width: 46, height: 46, objectFit: "cover", borderRadius: 8, background: "#fff", flexShrink: 0 }} />
          : <div style={{ width: 46, height: 46, borderRadius: 8, background: "var(--pm-s2)", flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{c.sku} {c.mistura && <Selo tom="azul">mistura</Selo>}</div>
          <div style={{ fontSize: 12, color: "var(--pm-t2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.nome ?? ""}>{c.nome}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 24, fontWeight: 750, fontVariantNumeric: "tabular-nums" }}>{brl(c.cv)}</div>
          <div style={{ fontSize: 11, color: "var(--pm-t3)" }}>custo variável / un</div>
        </div>
      </header>

      <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", background: "var(--pm-s2)" }} title="Composição do custo">
        {partes.filter((p) => p.v > 0).map((p) => (
          <div key={p.k} style={{ width: `${(p.v / total) * 100}%`, background: CORES[p.k as keyof typeof CORES] }} title={`${p.k}: ${brl(p.v)}`} />
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px", fontSize: 12.5 }}>
        <Linha r="Matéria-prima" v={brl(c.materia)} />
        <Linha r="Embalagem + etiqueta" v={brl(c.embalagem + c.etiqueta)} />
        <Linha r="Mão de obra" v={c.mod == null ? "—" : brl(c.mod)} />
        <Linha r="Prêmio + CIF" v={brl((c.premio ?? 0) + (c.cif ?? 0))} />
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", fontSize: 12 }}>
        <Selo tom={tomKg as "g" | "azul" | "a" | "n"}>{num(c.kg_un, 3)} kg/un · {FONTE_KG[fonteKg]}</Selo>
        <Selo>{brl(c.preco_kg, 4)}/kg · {FONTE_PRECO_KG[c.preco_kg_fonte] ?? c.preco_kg_fonte}</Selo>
        <Selo tom={c.mod_fonte.startsWith("manual") ? "azul" : c.mod_fonte === "sem_medida" ? "a" : "n"}>MOD {FONTE_MOD[c.mod_fonte] ?? c.mod_fonte}</Selo>
      </div>

      <div style={{ fontSize: 12, color: "var(--pm-t2)", display: "flex", gap: 12, flexWrap: "wrap" }}>
        {prod && <span style={{ width: "100%" }}>Produtividade <b>{num(prod.un_h_linha, 1)} sacos/h</b> de linha · <b>{num(prod.un_homem_hora, 1)}</b> por pessoa/hora{prod.do_grupo ? " (média do grupo)" : ` (${prod.lotes} ${prod.lotes === 1 ? "lote" : "lotes"}, ${int(prod.un_total)} sacos)`}</span>}
        <span>Padrão <b>{brl(c.cv_padrao)}</b></span>
        <span>Medido <b>{c.cv_medido == null ? "—" : brl(c.cv_medido)}</b></span>
        <span>Cenário <b>{brl(c.cv)}</b></span>
        {Math.abs(c.cv - c.cv_padrao) >= 0.005 && <span style={{ color: c.cv > c.cv_padrao ? "var(--pm-r)" : "var(--pm-g)" }}>{c.cv > c.cv_padrao ? "+" : ""}{brl(c.cv - c.cv_padrao)} vs padrão</span>}
      </div>

      {c.alerta_desperdicio && (
        <div style={{ background: "var(--pm-rs)", color: "var(--pm-r)", borderRadius: 9, padding: "8px 10px", fontSize: 12.5, fontWeight: 600 }}>
          Consumo medido {num(c.kg_un_medido, 3)} kg/un está {pct((c.kg_un_medido ?? 0) / c.kg_un_padrao - 1)} acima do padrão ({num(c.kg_un_padrao, 3)}):
          desperdício de {brl(c.desperdicio_un)} por saco, {brl(c.desperdicio_mes, 0)} por mês a {int(cenario.volume_mes_un)} un.
        </div>
      )}
      {c.avisos.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11.5, color: "var(--pm-am)" }}>{c.avisos.map((a) => <li key={a}>{a}</li>)}</ul>
      )}

      <div><Botao onClick={onAbrir}>{aberto ? "Fechar" : "Ajustar no cenário"}</Botao></div>
      {aberto && (pronto ? <EditorSku c={c} cfg={cfg} cenario={cenario} /> : <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>Carregando…</span>)}
    </section>
  );
}

const Linha = ({ r, v }: { r: string; v: string }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span style={{ color: "var(--pm-t3)" }}>{r}</span><b style={{ fontVariantNumeric: "tabular-nums" }}>{v}</b></div>
);

// ---------------------------------------------------------------------------
// Editor por SKU: grava em custo_cenario_sku (0,5 s depois de parar de digitar) e o banco recalcula
// ---------------------------------------------------------------------------
type Form = Record<keyof Omit<CenarioSku, "cenario_id" | "sku">, string>;
const NUMERICOS: Array<keyof Form> = ["kg_un_manual", "preco_kg_manual", "preco_mistura_un_manual", "embalagem_rs_un_manual", "etiqueta_rs_un_manual",
  "mod_rs_hora_manual", "un_homem_hora_manual", "mod_rs_un_manual", "premio_rs_lote", "un_por_lote", "cif_rs_un"];

function paraForm(cfg?: CenarioSku): Form {
  const s = (v: unknown) => (v == null ? "" : String(v).replace(".", ","));
  return {
    fonte_materia: cfg?.fonte_materia ?? "medido", kg_un_manual: s(cfg?.kg_un_manual), preco_kg_fonte: cfg?.preco_kg_fonte ?? "ultima_entrada",
    preco_kg_manual: s(cfg?.preco_kg_manual), preco_mistura_un_manual: s(cfg?.preco_mistura_un_manual),
    embalagem_rs_un_manual: s(cfg?.embalagem_rs_un_manual), etiqueta_rs_un_manual: s(cfg?.etiqueta_rs_un_manual),
    fonte_mod: cfg?.fonte_mod ?? "medido", mod_rs_hora_manual: s(cfg?.mod_rs_hora_manual), un_homem_hora_manual: s(cfg?.un_homem_hora_manual),
    mod_rs_un_manual: s(cfg?.mod_rs_un_manual), premio_rs_lote: s(cfg?.premio_rs_lote ?? 50), un_por_lote: s(cfg?.un_por_lote),
    cif_rs_un: s(cfg?.cif_rs_un ?? 0), observacao: cfg?.observacao ?? "",
  };
}

function EditorSku({ c, cfg, cenario }: { c: CustoSku; cfg?: CenarioSku; cenario: Cenario }) {
  const recalcular = useRecalcular();
  const [f, setF] = useState<Form>(() => paraForm(cfg));
  const [estado, setEstado] = useState<"" | "salvando" | "salvo" | "erro">("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function mudar(campo: keyof Form, valor: string) {
    const novo = { ...f, [campo]: valor };
    setF(novo);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void gravar(novo), 500);
  }

  async function gravar(v: Form) {
    const campos: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (NUMERICOS.includes(k as keyof Form)) {
        const t = val.trim().replace(",", ".");
        if (t === "") campos[k] = k === "premio_rs_lote" ? 0 : k === "cif_rs_un" ? 0 : null;
        else if (Number.isFinite(Number(t))) campos[k] = Number(t);
        else { setEstado("erro"); return; }
      } else campos[k] = k === "observacao" ? (val.trim() || null) : val;
    }
    setEstado("salvando");
    try { await salvarSku(cenario.id, c.sku, campos as Partial<CenarioSku>); setEstado("salvo"); recalcular(); }
    catch (e) { setEstado("erro"); toast.error("Não deu para salvar", { description: (e as Error).message }); }
  }

  const grupo = (titulo: string, filhos: React.ReactNode) => (
    <fieldset style={{ border: "1px solid var(--pm-b)", borderRadius: 10, padding: 10, margin: 0, minWidth: 0 }}>
      <legend style={{ fontSize: 12, fontWeight: 650, padding: "0 6px", color: "var(--pm-t2)" }}>{titulo}</legend>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: 8 }}>{filhos}</div>
    </fieldset>
  );
  const ent = (campo: keyof Form, rotulo: string, dica?: string, desligado?: boolean) => (
    <Campo rotulo={rotulo} dica={dica}>
      <Entrada inputMode="decimal" value={f[campo]} disabled={desligado} onChange={(e) => mudar(campo, e.target.value)} />
    </Campo>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 8, borderTop: "1px solid var(--pm-b)" }}>
      <div style={{ fontSize: 12, color: estado === "erro" ? "var(--pm-r)" : "var(--pm-t3)" }}>
        Cada mudança vale só para o cenário "{cenario.nome}" e não mexe nos dados de produção.
        {estado === "salvando" && " Salvando…"}{estado === "salvo" && " Salvo — custo recalculado."}{estado === "erro" && " Número inválido ou erro ao salvar."}
      </div>
      {grupo("Matéria-prima", <>
        <Campo rotulo="Consumo (kg por saco)" dica={`padrão ${num(c.kg_un_padrao, 3)} · medido ${c.kg_un_medido == null ? "—" : num(c.kg_un_medido, 3)}${c.bags_medidos ? ` (${c.bags_medidos} big bags)` : ""}`}>
          <Escolha value={f.fonte_materia} onChange={(e) => mudar("fonte_materia", e.target.value)}>
            <option value="medido">Medido (fechamento do big bag)</option><option value="padrao">Padrão da ficha</option><option value="manual">Manual</option>
          </Escolha>
        </Campo>
        {ent("kg_un_manual", "kg por saco (manual)", undefined, f.fonte_materia !== "manual")}
        <Campo rotulo={`Preço do kg — ${c.farinha_nome ?? "farinha"}`} dica={`última ${brl(c.preco_kg_ultima, 4)} · ref. ${brl(c.preco_kg_referencia, 4)} · 90 d ${brl(c.preco_kg_media_90d, 4)}`}>
          <Escolha value={f.preco_kg_fonte} onChange={(e) => mudar("preco_kg_fonte", e.target.value)}>
            <option value="ultima_entrada">Última entrada</option><option value="media_90d">Média 90 dias</option><option value="referencia">Referência</option><option value="manual">Manual</option>
          </Escolha>
        </Campo>
        {ent("preco_kg_manual", "R$/kg (manual)", undefined, f.preco_kg_fonte !== "manual")}
        {c.mistura && ent("preco_mistura_un_manual", `R$ por un de ${c.mistura_nome ?? "mistura"}`, `hoje ${brl(c.preco_mistura_un)} (custo do Tiny)`)}
      </>)}
      {grupo("Embalagem", <>
        {ent("embalagem_rs_un_manual", `Embalagem (R$/un)`, `${c.embalagem_nome ?? ""} · cadastro ${brl(c.embalagem, 4)} (vazio = cadastro)`)}
        {ent("etiqueta_rs_un_manual", "Etiqueta (R$/un)", `cadastro ${brl(c.etiqueta, 4)} (vazio = cadastro)`)}
      </>)}
      {grupo("Mão de obra", <>
        <Campo rotulo="Fonte" dica={`medida: ${c.mod_un_homem_hora == null ? "—" : `${num(c.mod_un_homem_hora, 1)} un/homem-hora`} · ${brl(c.mod_rs_hora)}/h`}>
          <Escolha value={f.fonte_mod} onChange={(e) => mudar("fonte_mod", e.target.value)}>
            <option value="medido">Medida nos lotes</option><option value="manual_hora">Manual: R$/hora e un/homem-hora</option><option value="manual_un">Manual: R$ por saco</option>
          </Escolha>
        </Campo>
        {ent("mod_rs_hora_manual", "R$ por homem-hora", undefined, f.fonte_mod !== "manual_hora")}
        {ent("un_homem_hora_manual", "Sacos por homem-hora", undefined, f.fonte_mod !== "manual_hora")}
        {ent("mod_rs_un_manual", "R$ por saco", undefined, f.fonte_mod !== "manual_un")}
      </>)}
      {grupo("Outros", <>
        {ent("premio_rs_lote", "Prêmio por big bag (R$)", `÷ ${num(c.un_por_lote, 0)} sacos = ${brl(c.premio, 4)}/un`)}
        {ent("un_por_lote", "Sacos por big bag", "vazio = 1.000 kg ÷ kg de farinha por saco")}
        {ent("cif_rs_un", "Indireto — CIF (R$/un)", "energia, espaço, depreciação")}
        <Campo rotulo="Observação"><Entrada value={f.observacao} onChange={(e) => mudar("observacao", e.target.value)} /></Campo>
      </>)}
    </div>
  );
}

// ---------------------------------------------------------------------------
function AcoesEmMassa({ cenario, linhas }: { cenario: Cenario; linhas: CustoSku[] }) {
  const recalcular = useRecalcular();
  const farinhas = useMemo(() => {
    const m = new Map<number, { nome: string; skus: string[]; preco: number }>();
    for (const l of linhas) if (l.farinha_id != null) {
      const x = m.get(l.farinha_id) ?? { nome: l.farinha_nome ?? `#${l.farinha_id}`, skus: [], preco: l.preco_kg };
      x.skus.push(l.sku); m.set(l.farinha_id, x);
    }
    return [...m.entries()];
  }, [linhas]);
  const [farinha, setFarinha] = useState<number | "">("");
  const [precoKg, setPrecoKg] = useState("");
  const [modH, setModH] = useState("");
  const [cif, setCif] = useState("");
  const n = (s: string) => Number(s.trim().replace(",", "."));

  async function aplicar(desc: string, fn: () => Promise<void>) {
    if (!window.confirm(`${desc}\n\nVale só para o cenário "${cenario.nome}".`)) return;
    try { await fn(); recalcular(); toast.success("Aplicado."); } catch (e) { toast.error("Não deu para aplicar", { description: (e as Error).message }); }
  }

  return (
    <Cartao titulo="Ações em massa">
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <Campo rotulo="Farinha"><Escolha value={farinha} onChange={(e) => setFarinha(e.target.value ? Number(e.target.value) : "")} style={{ width: 230 }}>
            <option value="">Escolha…</option>{farinhas.map(([id, x]) => <option key={id} value={id}>{x.nome} ({x.skus.length})</option>)}
          </Escolha></Campo>
          <Campo rotulo="R$/kg"><Entrada inputMode="decimal" value={precoKg} onChange={(e) => setPrecoKg(e.target.value)} style={{ width: 90 }} /></Campo>
          <Botao disabled={!farinha || !(n(precoKg) > 0)} onClick={() => {
            const x = farinhas.find(([id]) => id === farinha)?.[1]; if (!x) return;
            void aplicar(`Preço da farinha ${x.nome} = ${brl(n(precoKg), 4)}/kg em ${x.skus.join(", ")}?`,
              () => salvarSkus(cenario.id, x.skus, { preco_kg_fonte: "manual", preco_kg_manual: n(precoKg) }));
          }}>Aplicar</Botao>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <Campo rotulo="MOD R$/homem-hora" dica="mantém a produtividade medida de cada produto"><Entrada inputMode="decimal" value={modH} onChange={(e) => setModH(e.target.value)} style={{ width: 110 }} /></Campo>
          <Botao disabled={!(n(modH) > 0)} onClick={() => void aplicar(`Mão de obra a ${brl(n(modH))}/homem-hora em todos os produtos?`, async () => {
            for (const l of linhas) {
              if (!l.mod_un_homem_hora) continue;
              await salvarSku(cenario.id, l.sku, { fonte_mod: "manual_hora", mod_rs_hora_manual: n(modH), un_homem_hora_manual: l.mod_un_homem_hora });
            }
          })}>Aplicar a todos</Botao>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <Campo rotulo="CIF R$/un"><Entrada inputMode="decimal" value={cif} onChange={(e) => setCif(e.target.value)} style={{ width: 90 }} /></Campo>
          <Botao disabled={!(n(cif) >= 0) || cif.trim() === ""} onClick={() => void aplicar(`Custo indireto (CIF) de ${brl(n(cif), 4)} por saco em todos os produtos?`,
            () => salvarSkus(cenario.id, linhas.map((l) => l.sku), { cif_rs_un: n(cif) }))}>Aplicar a todos</Botao>
        </div>
      </div>
    </Cartao>
  );
}

// ---------------------------------------------------------------------------
function MaoDeObra() {
  const med = useMedicoes();
  const [verLotes, setVerLotes] = useState(false);
  const d = med.data;
  if (med.isLoading) return null;
  if (!d) return <Cartao titulo="Mão de obra"><span style={{ color: "var(--pm-r)" }}>Não deu para ler as medições.</span></Cartao>;
  const grupos = d.mod.filter((m) => m.sku == null);
  const inuteis = d.lotes.filter((l) => !l.limpo).length;
  return (
    <Cartao titulo="Mão de obra medida (cenário padrão)" direita={<Selo tom={inuteis ? "a" : "g"}>{inuteis} de {d.lotes.length} lotes com apontamento inútil</Selo>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }}>
        {grupos.map((g) => (
          <div key={g.grupo} style={{ background: "var(--pm-s2)", borderRadius: 10, padding: 10, fontSize: 12.5, display: "flex", flexDirection: "column", gap: 3 }}>
            <b>{g.grupo}</b>
            <span>{g.lotes} lotes · {int(g.un_total)} sacos · {num(g.horas_linha, 2)} h de linha · {num(g.homem_horas, 2)} homem-h</span>
            <span>Ritmo de linha <b>{num(g.un_h_linha, 1)} un/h</b> · <b>{num(g.un_homem_hora, 1)}</b> un/homem-hora</span>
            <span>{brl(g.rs_homem_hora_medio)}/homem-hora · MOD <b>{brl(g.mod_rs_un)}</b> por saco</span>
          </div>
        ))}
      </div>
      {d.dot.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5 }}>
          <b>Tamanho da equipe (mandioca pura, lotes limpos):</b>{" "}
          {d.dot.map((x) => <span key={x.pessoas} style={{ marginRight: 14 }}>{x.pessoas} pessoas → {num(x.un_homem_hora, 1)} un/homem-hora, MOD {brl(x.mod_rs_un)} ({x.lotes} lotes)</span>)}
          <div style={{ fontSize: 11.5, color: "var(--pm-t3)" }}>Decisão de escala: com menos gente por lote, cada pessoa rende mais; o ritmo da linha cai pouco.</div>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginTop: 8 }}>
        Limpo = lote entre 10 min e 4 h (misturas até 12 h) e, na mandioca pura, ritmo entre 40 e 150 sacos/h. Hoje as etapas de cada lote são
        carimbadas com a mesma janela da ordem, então homem-hora = pessoas × janela. Produto com menos de 2 lotes / 200 sacos limpos usa o número do grupo.
      </div>
      <div style={{ marginTop: 8 }}><Botao tom="fantasma" onClick={() => setVerLotes((v) => !v)}>{verLotes ? "Esconder lotes" : "Ver lotes"}</Botao></div>
      {verLotes && (
        <div style={{ overflowX: "auto" }}>
          <table style={tabela}>
            <thead><tr>{["Lote", "SKU", "Dia", "Sacos", "Janela", "Pessoas", "Homem-h", "R$", "un/h", "un/homem-h", "Situação"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{d.lotes.map((l) => (
              <tr key={l.ordem_id}>
                <td style={td}>{l.codigo}</td><td style={td}>{l.sku}</td><td style={td}>{l.dia?.split("-").reverse().slice(0, 2).join("/")}</td>
                <td style={td}>{int(l.un)}</td><td style={td}>{num(l.min_linha, 0)} min</td><td style={td} title={l.quem ?? ""}>{l.pessoas ?? "—"}</td>
                <td style={td}>{num(l.homem_horas, 2)}</td><td style={td}>{brl(l.custo)}</td><td style={td}>{num(l.un_h_linha, 1)}</td><td style={td}>{num(l.un_homem_hora, 1)}</td>
                <td style={td}>{l.limpo ? <Selo tom="g">limpo</Selo> : <Selo tom="a">{l.motivo}</Selo>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </Cartao>
  );
}

function MateriaPrima() {
  const med = useMedicoes();
  const bags = med.data?.bags ?? [];
  if (!bags.length) return null;
  const NOMES: Record<string, [string, "g" | "a" | "n" | "r"]> = {
    ok: ["entra na medição", "g"], mistura: ["mistura: fora", "n"], contaminada: ["pesos diferentes: fora", "a"],
    lote_aberto: ["lote aberto", "a"], sem_producao: ["sem produção", "n"], aberto: ["não fechado", "n"],
  };
  return (
    <Cartao titulo="Consumo de farinha pelo fechamento do big bag">
      <div style={{ fontSize: 11.5, color: "var(--pm-t3)", marginBottom: 6 }}>
        Só o big bag inteiro é medição: a baixa por lote lança o padrão ou joga o resto do saco no último lote. Um bag sozinho varia muito
        (sacos contados no lote de outro bag), por isso o número vale com 2 ou mais bags da mesma farinha.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={tabela}>
          <thead><tr>{["Big bag", "Farinha", "Consumido", "Produtos", "Sacos", "kg/saco", "Situação"].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>{bags.map((b) => (
            <tr key={b.entrada_id}>
              <td style={td}>{b.codigo}</td><td style={td}>{b.insumo.replace(/^Farinha de mandioca\s*/i, "")}</td><td style={td}>{kg(b.kg_consumido, 0)}</td>
              <td style={td}>{b.skus ?? "—"}</td><td style={td}>{int(b.un)}</td><td style={td}>{num(b.kg_un, 3)}</td>
              <td style={td}><Selo tom={NOMES[b.situacao]?.[1] ?? "n"}>{NOMES[b.situacao]?.[0] ?? b.situacao}</Selo></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </Cartao>
  );
}
