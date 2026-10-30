// Chão de fábrica — a tela que fica no celular da bancada. Uma mão, mão suja: botões grandes,
// um campo de número só (o peso, em gramas). Cada toque é uma linha no banco; os totais vêm da
// view_producao_lote (relida a cada 5 s), então dois celulares no mesmo lote se enxergam.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { Botao, Campo, Cartao, Entrada, Escolha, Numero, Selo } from "./ui";
import { DialogoLancarTiny } from "./TinyProducao";
import {
  ETAPAS, MOTIVOS_PARADA, MOTIVOS_REFUGO, brl, dataBR, erroMsg, horaBR, int, kg, minutos, nomeMotivoParada, periodoBR, useFotos,
  proximaPesagem, useLote, usePessoas, type Etapa, type Lote,
} from "@/lib/producao";

export function ChaoFabrica({ id, onVoltar }: { id: number; onVoltar: () => void }) {
  const qc = useQueryClient();
  const lote = useLote(id);
  const pessoas = usePessoas();
  const [pendente, setPendente] = useState(0);        // toques ainda não confirmados pelo banco
  const [peso, setPeso] = useState("");
  const [painel, setPainel] = useState<null | "refugo" | "parada" | "pessoas" | "encerrar">(null);

  const l = lote.data;
  const recarregar = () => qc.invalidateQueries({ queryKey: ["producao"] });
  const nomePessoa = (pid?: string) => pessoas.data?.find((p) => p.id === pid)?.nome ?? pid ?? "—";
  const quemEnvase = l?.pessoas?.envase ?? null;
  const foto = useFotos(l ? [l.sku] : []).data?.[l?.sku ?? ""];

  async function gravar(tabela: string, linha: Record<string, unknown>, okMsg?: string) {
    const { error } = await supabaseExternal.from(tabela as never).insert({ ordem_id: id, ...linha } as never);
    if (error) { toast.error(erroMsg(error)); return false; }
    if (okMsg) toast.success(okMsg);
    await recarregar();
    return true;
  }

  async function contar(n: number) {
    if (!l) return;
    if (n < 0 && l.envasados + pendente <= 0) return;
    setPendente((p) => p + n);
    await gravar("producao_contagem", { qtd: n, pessoa_id: quemEnvase });
    setPendente((p) => p - n);
  }

  async function gravarPeso() {
    const g = Number(peso.replace(/\D/g, ""));
    if (!(g >= 100 && g <= 20000)) return toast.error("Digite o peso em gramas (ex.: 4025).");
    if (await gravar("producao_pesagem", { peso_g: g, pessoa_id: quemEnvase })) setPeso("");
  }

  if (lote.isLoading) return <p style={{ padding: 20, color: "var(--pm-t3)" }}>Carregando o lote…</p>;
  if (!l) return (
    <div style={{ padding: 20 }}>
      <p>Lote não encontrado.</p><Botao onClick={onVoltar}>Voltar</Botao>
    </div>
  );

  const envasados = l.envasados + pendente;
  const fechado = l.status !== "aberta";
  const pes = proximaPesagem({ ...l, envasados });
  const corPeso = l.alerta_peso === "abaixo_nominal" ? "r" : l.alerta_peso === "atencao" ? "a" : l.alerta_peso === "ok" ? "g" : undefined;
  const faltamFardo = Math.max(0, l.boas + pendente - l.sacos_em_fardo);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720, margin: "0 auto" }}>
      {/* Cabeçalho: o código vai na datadora */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Botao tom="fantasma" onClick={onVoltar}>‹ Produção</Botao>
        <div style={{ flex: 1 }} />
        {fechado ? <Selo>{l.status}</Selo> : l.parado_agora ? <Selo tom="r">parado · {nomeMotivoParada(l.parada_motivo)}</Selo> : <Selo tom="g">rodando</Selo>}
      </div>
      <Cartao>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {foto && <img src={foto} alt="" width={64} height={64} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, border: "1px solid var(--pm-bs)", background: "#fff", flexShrink: 0 }} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 0.5, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>{l.codigo}</div>
            <div style={{ fontSize: 13, color: "var(--pm-t2)", marginTop: 2 }}>{l.sku} · {l.produto}</div>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: "var(--pm-t3)", marginTop: 6 }}>
          Big bag {l.big_bag} · {l.embalagem} · {fechado ? `produção ${periodoBR(l.inicio_em, l.fim_em)}` : `começou ${horaBR(l.inicio_em)}`}
        </div>
      </Cartao>

      {/* Números do lote */}
      <Cartao>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 12 }}>
          <Numero rotulo="Envasados" valor={int(envasados)} sub={l.qtd_planejada ? `de ${int(l.qtd_planejada)} planejados` : undefined} />
          <Numero rotulo="Boas" valor={int(l.boas + pendente)} sub={l.refugo ? `${int(l.refugo)} refugo` : "sem refugo"} />
          <Numero rotulo="Em fardo" valor={int(l.sacos_em_fardo)} sub={faltamFardo ? `${int(faltamFardo)} soltos` : "tudo em fardo"} />
          <Numero rotulo="Ritmo" valor={l.un_hora != null ? `${int(l.un_hora)}/h` : "—"} sub={`${minutos(l.minutos_total)} · parado ${minutos(l.minutos_parados)}`} />
        </div>
      </Cartao>

      {!fechado && (
        <>
          {/* Contagem: os botões grandes */}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10 }}>
            <Botao tom="primario" grande onClick={() => contar(1)} style={{ fontSize: 40, minHeight: 120 }}>+1</Botao>
            <div style={{ display: "grid", gridTemplateRows: "1fr 1fr", gap: 10 }}>
              <Botao tom="secundario" grande onClick={() => contar(10)} style={{ fontSize: 26 }}>+10</Botao>
              <Botao tom="secundario" grande onClick={() => contar(-1)} style={{ fontSize: 18 }}>desfazer 1</Botao>
            </div>
          </div>

          {/* Peso: o único campo de número */}
          <Cartao
            titulo="Peso (gramas)"
            direita={pes.devida ? <Selo tom="a">pese agora</Selo> : pes.faltam ? <Selo>próxima em {int(pes.faltam)} sacos</Selo> : null}
          >
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
              <input
                inputMode="numeric"
                value={peso}
                onChange={(e) => setPeso(e.target.value.replace(/\D/g, "").slice(0, 5))}
                onKeyDown={(e) => { if (e.key === "Enter") void gravarPeso(); }}
                placeholder={String(l.nominal_g)}
                style={{ height: 64, fontSize: 32, fontWeight: 700, textAlign: "center", borderRadius: 14, border: "2px solid var(--pm-bc)", background: "var(--pm-s)", color: "var(--pm-t)", fontVariantNumeric: "tabular-nums", minWidth: 0 }}
              />
              <Botao tom="primario" grande onClick={gravarPeso} style={{ fontSize: 18, minWidth: 110 }}>Gravar</Botao>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 10, marginTop: 12 }}>
              <Numero rotulo="Média" valor={l.media_g != null ? `${int(l.media_g)} g` : "—"} tom={corPeso} sub={`${int(l.pesagens)} pesagens`} />
              <Numero rotulo="Mín / máx" valor={l.min_g != null ? `${int(l.min_g)} / ${int(l.max_g)}` : "—"} />
              <Numero rotulo="Desvio" valor={l.desvio_g != null ? `${int(l.desvio_g)} g` : "—"} />
              <Numero rotulo={`Abaixo de ${int(l.nominal_g - l.tolerancia_g)} g`} valor={int(l.abaixo_t)} tom={l.abaixo_t ? "r" : undefined} />
            </div>
            {l.alerta_peso === "abaixo_nominal" && (
              <p style={{ margin: "10px 0 0", fontSize: 13, fontWeight: 600, color: "var(--pm-r)" }}>
                A média está abaixo de {int(l.nominal_g)} g: confira a balança e ponha mais em cada saco.
              </p>
            )}
            {l.alerta_peso === "atencao" && (
              <p style={{ margin: "10px 0 0", fontSize: 13, fontWeight: 600, color: "var(--pm-am)" }}>
                A média está chegando perto de {int(l.nominal_g)} g. Fique de olho no peso.
              </p>
            )}
          </Cartao>

          {/* Fardos */}
          <Cartao titulo="Fechar fardo" direita={l.fardos ? <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>{Object.entries(l.fardos).filter(([, n]) => n).map(([s, n]) => `${n}× de ${s}`).join(" · ")}</span> : null}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
              {[2, 3, 5].map((s) => (
                <Botao key={s} tom="secundario" grande style={{ fontSize: 18 }}
                  onClick={() => gravar("producao_fardo", { sacos_por_fardo: s, qtd_fardos: 1, pessoa_id: l.pessoas?.fardos ?? null })}>
                  de {s}
                </Botao>
              ))}
              <Botao tom="fantasma" grande style={{ fontSize: 14 }} disabled={!l.sacos_em_fardo} onClick={async () => {
                const { data, error } = await supabaseExternal.from("producao_fardo" as never).select("id")
                  .eq("ordem_id", id).order("em", { ascending: false }).limit(1);
                const ultimo = (data as unknown as Array<{ id: number }> | null)?.[0];
                if (error || !ultimo) return toast.error(error ? erroMsg(error) : "Nenhum fardo para desfazer.");
                const { error: e2 } = await supabaseExternal.from("producao_fardo" as never).delete().eq("id", ultimo.id);
                if (e2) return toast.error(erroMsg(e2));
                toast.success("Último fardo desfeito.");
                await recarregar();
              }}>desfazer</Botao>
            </div>
          </Cartao>

          {/* Refugo · Parada · Pessoas · Encerrar */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <Botao tom="secundario" grande style={{ fontSize: 18, color: "var(--pm-r)" }} onClick={() => setPainel("refugo")}>Refugo</Botao>
            {l.parado_agora ? (
              <Botao tom="ok" grande style={{ fontSize: 18 }} onClick={async () => {
                const { error } = await supabaseExternal.from("producao_parada" as never).update({ fim_em: new Date().toISOString() } as never)
                  .eq("ordem_id", id).is("fim_em", null);
                if (error) return toast.error(erroMsg(error));
                await recarregar();
              }}>Retomar</Botao>
            ) : (
              <Botao tom="secundario" grande style={{ fontSize: 18 }} onClick={() => setPainel("parada")}>Parar</Botao>
            )}
            <Botao tom="secundario" onClick={() => setPainel("pessoas")} style={{ height: 48 }}>Quem está em cada etapa</Botao>
            <Botao tom="perigo" onClick={() => setPainel("encerrar")} style={{ height: 48 }}>Encerrar lote</Botao>
          </div>
        </>
      )}

      {fechado && <Fechamento l={l} />}

      {/* Escolhas em lista grande */}
      <Dialog open={painel === "refugo" || painel === "parada"} onOpenChange={(v) => !v && setPainel(null)}>
        <DialogContent className="pm-ui max-w-md" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
          <DialogHeader><DialogTitle>{painel === "refugo" ? "Motivo do refugo (1 saco)" : "Motivo da parada"}</DialogTitle></DialogHeader>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(painel === "refugo" ? MOTIVOS_REFUGO : MOTIVOS_PARADA).map((m) => (
              <Botao key={m.id} tom="secundario" grande style={{ fontSize: 16 }} onClick={async () => {
                setPainel(null);
                if (painel === "refugo") {
                  const etapa = (m as (typeof MOTIVOS_REFUGO)[number]).etapa;
                  await gravar("producao_refugo", { etapa, motivo: m.id, qtd: 1, pessoa_id: l.pessoas?.[etapa] ?? quemEnvase }, "Refugo registrado.");
                } else {
                  await gravar("producao_parada", { motivo: m.id, pessoa_id: quemEnvase }, "Parada registrada. Toque em Retomar quando voltar.");
                }
              }}>{m.nome}</Botao>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Pessoas aberto={painel === "pessoas"} onFechar={() => setPainel(null)} lote={l} onMudou={recarregar}
        pessoas={pessoas.data ?? []} nomePessoa={nomePessoa} />
      <Encerrar aberto={painel === "encerrar"} onFechar={() => setPainel(null)} lote={l} onEncerrado={recarregar} />
    </div>
  );
}

function Pessoas({ aberto, onFechar, lote, pessoas, nomePessoa, onMudou }: {
  aberto: boolean; onFechar: () => void; lote: Lote; pessoas: Array<{ id: string; nome: string }>;
  nomePessoa: (id?: string) => string; onMudou: () => void;
}) {
  const etapas = ETAPAS.filter((e) => e.id !== "etiquetagem" || lote.precisa_etiqueta);
  async function trocar(etapa: Etapa, pessoa: string) {
    const agora = new Date().toISOString();
    const { error: e1 } = await supabaseExternal.from("producao_etapa" as never).update({ fim_em: agora } as never)
      .eq("ordem_id", lote.id).eq("etapa", etapa).is("fim_em", null);
    if (e1) return toast.error(erroMsg(e1));
    if (pessoa) {
      const { error } = await supabaseExternal.from("producao_etapa" as never).insert({ ordem_id: lote.id, etapa, pessoa_id: pessoa } as never);
      if (error) return toast.error(erroMsg(error));
    }
    toast.success(pessoa ? `${nomePessoa(pessoa)} na ${ETAPAS.find((x) => x.id === etapa)?.nome.toLowerCase()}.` : "Etapa sem pessoa.");
    onMudou();
  }
  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-md" style={{ background: "var(--pm-s)", color: "var(--pm-t)" }}>
        <DialogHeader><DialogTitle>Quem está em cada etapa</DialogTitle></DialogHeader>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {etapas.map((e) => (
            <Campo key={e.id} rotulo={e.nome}>
              <Escolha value={lote.pessoas?.[e.id] ?? ""} onChange={(ev) => trocar(e.id, ev.target.value)} style={{ height: 44, fontSize: 16 }}>
                <option value="">—</option>
                {pessoas.map((p) => <option key={p.id} value={p.id}>{p.nome}</option>)}
              </Escolha>
            </Campo>
          ))}
          <p style={{ fontSize: 12, color: "var(--pm-t3)", margin: 0 }}>A troca fica registrada com o horário: cada pessoa leva o crédito do trecho em que esteve na etapa.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Encerrar({ aberto, onFechar, lote, onEncerrado }: { aberto: boolean; onFechar: () => void; lote: Lote; onEncerrado: () => void }) {
  const [boas, setBoas] = useState("");
  const [refugo, setRefugo] = useState("");
  const [embs, setEmbs] = useState("");
  const [etiq, setEtiq] = useState("");
  const [bagAcabou, setBagAcabou] = useState(false);
  // Pacotes do componente da mistura (16640: tofu 16080). null = acompanha o padrão da receita até alguém digitar.
  const [pacotes, setPacotes] = useState<string | null>(null);
  const [obs, setObs] = useState("");
  const [salvando, setSalvando] = useState(false);
  // Fardos prontos por tamanho (sacos por fardo → quantos fardos). Abre com o que foi marcado no chão de fábrica.
  const [fardos, setFardos] = useState<Record<number, string>>({});
  const tamanhos = [...new Set([2, 3, 5, ...Object.keys(lote.fardos ?? {}).map(Number)])].filter((s) => s > 0).sort((a, b) => a - b);

  // Abre sempre com o que o chão de fábrica contou.
  const [abriuPara, setAbriuPara] = useState<number | null>(null);
  if (aberto && abriuPara !== lote.id) {
    setAbriuPara(lote.id);
    setBoas(String(lote.boas)); setRefugo(String(lote.refugo)); setEmbs(String(lote.envasados));
    setEtiq(lote.precisa_etiqueta ? String(lote.envasados) : "0"); setBagAcabou(false); setPacotes(null); setObs("");
    setFardos(Object.fromEntries(tamanhos.map((s) => [s, String(lote.fardos?.[String(s)] ?? 0)])));
  }
  if (!aberto && abriuPara !== null) setAbriuPara(null);

  const n = (s: string | undefined) => Number((s ?? "").replace(",", ".") || 0);
  const sacosEmFardo = tamanhos.reduce((t, s) => t + s * n(fardos[s]), 0);
  const totalFardos = tamanhos.reduce((t, s) => t + n(fardos[s]), 0);
  const soltos = n(boas) - sacosEmFardo;
  // Farinha do lote = sacos envasados × consumo padrão (o big bag não é pesado); "acabou" lança o saldo inteiro.
  // Com mistura, a equipe conta os pacotes do componente abertos e a farinha = pacotes × kg de farinha por pacote.
  const mistura = !!(lote.mistura_un_kg && lote.mistura_farinha_kg);
  const pacotesPadrao = mistura ? Math.round((n(boas) + n(refugo)) * (lote.mistura_un_por_saco ?? 0)) : 0;
  const pacotesN = pacotes == null ? pacotesPadrao : n(pacotes);
  const farinhaKg = mistura ? pacotesN * (lote.mistura_farinha_kg ?? 0) : (n(boas) + n(refugo)) * lote.consumo_padrao_kg;

  async function encerrar() {
    if (soltos < 0) return toast.error(`Os fardos somam ${sacosEmFardo} sacos, mais que os ${n(boas)} sacos bons.`);
    const resumoFardos = tamanhos.filter((s) => n(fardos[s]) > 0).map((s) => `${n(fardos[s])} de ${s}`).join(", ");
    if (!window.confirm(
      `Encerrar o lote ${lote.codigo} com ${n(boas)} sacos bons?\n\n` +
      `Fardos prontos: ${resumoFardos || "nenhum"}${soltos > 0 ? ` · ${soltos} saco(s) soltos` : ""}.\n\n` +
      (bagAcabou ? `O big bag ${lote.big_bag} acabou: todo o saldo dele entra neste lote.\n`
        : `Sai do big bag ${lote.big_bag}: ${kg(farinhaKg, 0)} de farinha.\n`) +
      (mistura ? `Pacotes de ${lote.mistura_nome} usados: ${int(pacotesN)} (saem do Tiny ao lançar o lote).\n` : "") +
      "\nDepois de encerrado, o consumo fica gravado.",
    )) return;
    setSalvando(true);
    // Acerta os fardos ao que foi apontado agora: grava só a diferença de cada tamanho (negativo = desfazer).
    const ajustes = tamanhos
      .map((s) => ({ s, dif: n(fardos[s]) - Number(lote.fardos?.[String(s)] ?? 0) }))
      .filter((a) => a.dif !== 0)
      .map((a) => ({ ordem_id: lote.id, sacos_por_fardo: a.s, qtd_fardos: a.dif, pessoa_id: lote.pessoas?.fardos ?? null }));
    if (ajustes.length) {
      const { error: ef } = await supabaseExternal.from("producao_fardo" as never).insert(ajustes as never);
      if (ef) { setSalvando(false); return toast.error(`Não gravei os fardos: ${erroMsg(ef)}`); }
    }
    const { error } = await supabaseExternal.rpc("producao_encerrar_lote" as never, {
      p_ordem: lote.id, p_boas: n(boas), p_refugo: n(refugo), p_embalagens: n(embs),
      p_etiquetas: n(etiq), p_sobra_kg: 0, p_bag_acabou: bagAcabou, p_obs: obs || null,
      p_mistura_un: mistura ? pacotesN : null,
    } as never);
    setSalvando(false);
    if (error) return toast.error(erroMsg(error));
    toast.success(`Lote ${lote.codigo} encerrado.`);
    onFechar();
    onEncerrado();
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && onFechar()}>
      <DialogContent className="pm-ui max-w-md" style={{ background: "var(--pm-s)", color: "var(--pm-t)", maxHeight: "92vh", overflowY: "auto" }}>
        <DialogHeader><DialogTitle>Encerrar {lote.codigo}</DialogTitle></DialogHeader>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Campo rotulo="Sacos bons"><Entrada inputMode="numeric" value={boas} onChange={(e) => setBoas(e.target.value)} /></Campo>
          <Campo rotulo="Refugo"><Entrada inputMode="numeric" value={refugo} onChange={(e) => setRefugo(e.target.value)} /></Campo>
          <Campo rotulo="Embalagens usadas"><Entrada inputMode="numeric" value={embs} onChange={(e) => setEmbs(e.target.value)} /></Campo>
          {lote.precisa_etiqueta && <Campo rotulo="Etiquetas usadas"><Entrada inputMode="numeric" value={etiq} onChange={(e) => setEtiq(e.target.value)} /></Campo>}
          {mistura && (
            <div style={{ gridColumn: "1 / -1" }}>
              <Campo rotulo={`Pacotes de ${lote.mistura_nome ?? "componente"} abertos`}
                dica={`padrão para ${int(n(boas) + n(refugo))} sacos: ${int(pacotesPadrao)} · cada pacote vai com ${kg(lote.mistura_farinha_kg, 0)} de farinha`}>
                <Entrada inputMode="numeric" value={pacotes ?? String(pacotesPadrao)}
                  onChange={(e) => setPacotes(e.target.value.replace(/D/g, ""))} />
              </Campo>
            </div>
          )}
          <label style={{ gridColumn: "1 / -1", display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={bagAcabou} onChange={(e) => setBagAcabou(e.target.checked)} style={{ width: 18, height: 18, marginTop: 1 }} />
            <span>
              <b>O big bag {lote.big_bag} acabou neste lote</b>
              <span style={{ display: "block", fontSize: 12, color: "var(--pm-t3)" }}>
                {bagAcabou
                  ? "Todo o saldo que restava no big bag entra neste lote: é aqui que aparece o rendimento real do bag."
                  : mistura
                    ? `Sai do big bag ≈ ${kg(farinhaKg, 0)} (${int(pacotesN)} pacotes × ${kg(lote.mistura_farinha_kg, 0)}).`
                    : `Sai do big bag ≈ ${kg(farinhaKg, 0)} (${int(n(boas) + n(refugo))} sacos × ${kg(lote.consumo_padrao_kg, 3)}).`}
              </span>
            </span>
          </label>
          <div style={{ gridColumn: "1 / -1", border: "1px solid var(--pm-bs)", borderRadius: 10, padding: 10 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, fontWeight: 650 }}>Fardos prontos</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: soltos < 0 ? "var(--pm-r)" : "var(--pm-t3)" }}>
                {int(totalFardos)} fardo(s) · {int(sacosEmFardo)} sacos
                {soltos > 0 ? ` · ${int(soltos)} soltos` : soltos < 0 ? ` · ${int(-soltos)} a mais que os bons` : " · nenhum solto"}
              </span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${tamanhos.length}, 1fr)`, gap: 8 }}>
              {tamanhos.map((s) => (
                <Campo key={s} rotulo={`Fardos de ${s}`}>
                  <Entrada inputMode="numeric" value={fardos[s] ?? "0"}
                    onChange={(e) => setFardos((f) => ({ ...f, [s]: e.target.value.replace(/\D/g, "") }))} />
                </Campo>
              ))}
            </div>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Campo rotulo="Observação"><Entrada value={obs} onChange={(e) => setObs(e.target.value)} /></Campo>
          </div>
        </div>
        <p style={{ fontSize: 12, color: "var(--pm-t3)", margin: "4px 0 0" }}>
          A farinha sai do big bag pela quantidade produzida (sacos × consumo padrão da ficha). Marque "acabou" no último lote do bag.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <Botao onClick={onFechar}>Voltar</Botao>
          <Botao tom="perigo" onClick={encerrar} disabled={salvando}>{salvando ? "Encerrando…" : "Encerrar lote"}</Botao>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Fechamento({ l }: { l: Lote }) {
  const qc = useQueryClient();
  const [tiny, setTiny] = useState(false);
  const rend = l.consumo_real_kg && l.boas ? l.consumo_real_kg / l.boas : null;
  const difCusto = l.custo_real_un != null ? l.custo_real_un - l.custo_padrao_un : null;
  return (
    <Cartao titulo="Fechamento do lote">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 12 }}>
        <Numero rotulo="Sacos bons" valor={int(l.boas)} sub={`${int(l.refugo)} refugo`} />
        <Numero rotulo="Farinha usada" valor={kg(l.consumo_real_kg, 0)} sub={`padrão ${kg(l.consumo_padrao_total_kg, 0)}`} />
        <Numero rotulo="Farinha por saco" valor={rend != null ? kg(rend, 3) : "—"} sub={`padrão ${kg(l.farinha_padrao_kg, 3)}`}
          tom={rend != null && rend > l.farinha_padrao_kg * 1.01 ? "r" : rend != null ? "g" : undefined} />
        {l.mistura_sku && (
          <Numero rotulo={`Pacotes ${l.mistura_sku}`} valor={int(l.mistura_un_usadas)}
            sub={`padrão ${int(Math.round(l.boas * (l.mistura_un_por_saco ?? 0)))} · ${brl(l.mistura_custo_un)}/un`} />
        )}
        <Numero rotulo="Custo por saco" valor={brl(l.custo_real_un)} sub={`padrão ${brl(l.custo_padrao_un)}`}
          tom={difCusto != null ? (difCusto > 0.05 ? "r" : "g") : undefined} />
        <Numero rotulo="Peso médio" valor={l.media_g != null ? `${int(l.media_g)} g` : "—"} sub={`${int(l.abaixo_t)} abaixo do limite`} tom={l.abaixo_t ? "r" : undefined} />
        <Numero rotulo="Ritmo" valor={l.un_hora != null ? `${int(l.un_hora)}/h` : "—"} sub={`${minutos(l.minutos_total)} · parado ${minutos(l.minutos_parados)}`} />
        <Numero rotulo="Começou" valor={horaBR(l.inicio_em)} sub={dataBR(l.inicio_em)} />
        <Numero rotulo="Terminou" valor={horaBR(l.fim_em)} sub={l.fim_em ? dataBR(l.fim_em) : "—"} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
        {l.tiny_lancado_em ? (
          <Selo tom="g">lançado no Tiny em {dataBR(l.tiny_lancado_em)} {horaBR(l.tiny_lancado_em)}</Selo>
        ) : (
          <>
            <Botao tom="primario" onClick={() => setTiny(true)}>Lançar no Tiny</Botao>
            <span style={{ fontSize: 12, color: "var(--pm-t3)" }}>
              entrada dos sacos bons no depósito Geral{l.mistura_sku ? ` e saída dos pacotes do ${l.mistura_sku}` : ""} (as outras matérias-primas ficam só no app)
            </span>
          </>
        )}
      </div>
      {tiny && (
        <DialogoLancarTiny aberto onFechar={() => setTiny(false)} refId={l.id} titulo={`Lote ${l.codigo} no Tiny`}
          onFeito={() => void qc.invalidateQueries({ queryKey: ["producao"] })} />
      )}
    </Cartao>
  );
}
