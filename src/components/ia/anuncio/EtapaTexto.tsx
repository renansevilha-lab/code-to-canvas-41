import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Loader2, PencilLine, RotateCcw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { ROTULO_ETAPA, chamarIa, type IaBriefing, type IaEtapa, type IaRascunho } from "@/lib/iaAnuncio";

export function SeloEtapa({ etapa }: { etapa: IaEtapa | undefined }) {
  if (!etapa) return null;
  const r = ROTULO_ETAPA[etapa.status] ?? { rotulo: etapa.status, cor: "#64748B" };
  return (
    <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style={{ background: `${r.cor}18`, color: r.cor }}>
      {etapa.status === "gerando" && <Loader2 className="h-3 w-3 animate-spin inline mr-1 -mt-0.5" />}{r.rotulo}
    </span>
  );
}

export async function decidirEtapa(etapaId: string, aprovar: boolean) {
  const { error } = await supabaseExternal.rpc(aprovar ? "ia_etapa_aprovar" : "ia_etapa_rejeitar", { p_etapa: etapaId });
  if (error) throw error;
}

/** Etapa 1: briefing + título/descrição/bullets. O preço fica no PainelPreco (não depende da IA). */
export function EtapaTexto({ sku, canal, empresa, rascunho, etapa, briefing, onCriado }: {
  sku: string; canal: string; empresa: string; rascunho: IaRascunho | null; etapa: IaEtapa | undefined;
  briefing: IaBriefing | null; onCriado: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [gerando, setGerando] = useState(false);
  const [obs, setObs] = useState("");
  const [titulo, setTitulo] = useState(""); const [descricao, setDescricao] = useState(""); const [bullets, setBullets] = useState<string[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [criando, setCriando] = useState(false);
  useEffect(() => {
    setTitulo(rascunho?.titulo ?? ""); setDescricao(rascunho?.descricao ?? ""); setBullets(rascunho?.bullet_points ?? []);
  }, [rascunho?.id, rascunho?.updated_at]);
  const recarregar = () => void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
  const editado = !!rascunho && (titulo !== (rascunho.titulo ?? "") || descricao !== (rascunho.descricao ?? "")
    || JSON.stringify(bullets) !== JSON.stringify(rascunho.bullet_points ?? []));

  async function gerar(refazer: boolean) {
    setGerando(true);
    try {
      const r = await chamarIa("texto", { sku, canal, empresa, rascunho_id: refazer ? rascunho?.id : undefined, observacao: refazer ? obs : undefined });
      const avisos = (r.avisos ?? []) as string[];
      if (r.status === "erro") toast.warning("Texto gerado, mas uma regra bloqueou", { description: avisos.join("\n") || r.erro });
      else toast.success(refazer ? "Texto gerado" : "Texto gerado e rascunho criado", { description: avisos.slice(0, 3).join("\n") || undefined });
      if (!refazer && r.rascunho_id) onCriado(r.rascunho_id);
      setObs("");
      recarregar();
    } catch (e) {
      toast.error("Falha ao gerar o texto", { description: (e as Error).message });
    } finally { setGerando(false); }
  }
  // rascunho sem IA: cria a linha (com o preço calculado) e a pessoa escreve o texto à mão
  async function comecarAMao() {
    setCriando(true);
    const { data, error } = await supabaseExternal.rpc("ia_rascunho_criar", { p_sku: sku, p_canal: canal, p_empresa: empresa });
    setCriando(false);
    if (error) { toast.error("Não foi possível criar o rascunho", { description: error.message }); return; }
    onCriado(String(data));
    recarregar();
  }
  async function salvarEdicao() {
    if (!rascunho) return;
    if (!titulo.trim()) { toast.error("Escreva o título antes de salvar"); return; }
    setSalvando(true);
    const { error } = await supabaseExternal.from("ia_rascunho")
      .update({ titulo: titulo.trim(), descricao: descricao.trim(), bullet_points: bullets.map((b) => b.trim()).filter(Boolean) })
      .eq("id", rascunho.id);
    setSalvando(false);
    if (error) { toast.error("Falha ao salvar", { description: error.message }); return; }
    toast.success("Edição salva — a etapa volta para revisão");
    recarregar();
  }
  async function decidir(aprovar: boolean) {
    if (!etapa) return;
    try { await decidirEtapa(etapa.id, aprovar); recarregar(); }
    catch (e) { toast.error("Não foi possível", { description: (e as Error).message }); }
  }

  if (!rascunho) {
    return (
      <Card><CardContent className="p-5 space-y-3">
        <h3 className="font-semibold">1 · Texto</h3>
        <p className="text-sm text-muted-foreground">
          A IA lê a foto real e os contextos do produto, monta o briefing (público, dores, benefícios) e escreve título,
          descrição e bullets para o canal escolhido. Se preferir, comece o rascunho em branco e escreva à mão.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={gerando || criando} onClick={() => void gerar(false)} className="gap-1.5">
            {gerando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {gerando ? "Gerando (até 1 min)…" : "Gerar texto com IA"}
          </Button>
          <Button variant="outline" disabled={gerando || criando} onClick={() => void comecarAMao()} className="gap-1.5">
            {criando ? <Loader2 className="h-4 w-4 animate-spin" /> : <PencilLine className="h-4 w-4" />}Escrever à mão
          </Button>
        </div>
      </CardContent></Card>
    );
  }

  const mem = rascunho.memoria_calculo ?? {};
  const avisos = (mem.avisos ?? []) as string[];
  return (
    <Card><CardContent className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold mr-1">1 · Texto</h3>
        <SeloEtapa etapa={etapa} />
        <div className="flex-1" />
        {etapa && ["gerado", "rejeitado", "erro"].includes(etapa.status) && (
          <Button size="sm" className="h-7 gap-1" onClick={() => void decidir(true)} disabled={editado}><Check className="h-3.5 w-3.5" />Aprovar texto</Button>
        )}
        {etapa && ["gerado", "aprovado"].includes(etapa.status) && (
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={() => void decidir(false)}><X className="h-3.5 w-3.5" />Rejeitar</Button>
        )}
      </div>
      {rascunho.erro && <p className="text-sm text-destructive">{rascunho.erro}</p>}
      {avisos.length > 0 && <p className="text-xs text-amber-600">Avisos: {avisos.join(" · ")}</p>}

      <label className="block">
        <span className="text-[11px] text-muted-foreground">Título ({titulo.length} caracteres)</span>
        <Input className="mt-1" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
      </label>
      <label className="block">
        <span className="text-[11px] text-muted-foreground">Descrição</span>
        <Textarea className="mt-1 min-h-[180px] text-sm" value={descricao} onChange={(e) => setDescricao(e.target.value)} />
      </label>
      <div>
        <span className="text-[11px] text-muted-foreground">Bullets</span>
        <div className="space-y-1.5 mt-1">
          {bullets.map((b, i) => (
            <div key={i} className="flex gap-1.5">
              <Input className="h-8 text-sm" value={b} onChange={(e) => setBullets((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} />
              <Button size="sm" variant="ghost" className="h-8 w-8 p-0" title="Tirar" onClick={() => setBullets((xs) => xs.filter((_, j) => j !== i))}><X className="h-3.5 w-3.5" /></Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setBullets((xs) => [...xs, ""])}>+ bullet</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Button size="sm" disabled={!editado || salvando} onClick={() => void salvarEdicao()}>
          {salvando && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}Salvar edição
        </Button>
        <div className="flex-1" />
        <Input className="h-8 max-w-[360px] text-sm" value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Observação para refazer (opcional)" />
        <Button size="sm" variant="outline" className="gap-1" disabled={gerando} onClick={() => void gerar(true)}>
          {gerando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : rascunho.titulo ? <RotateCcw className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
          {rascunho.titulo ? "Refazer texto com IA" : "Gerar texto com IA"}
        </Button>
      </div>

      {briefing && <Briefing briefing={briefing} sku={sku} />}
    </CardContent></Card>
  );
}

function Briefing({ briefing, sku }: { briefing: IaBriefing; sku: string }) {
  const qc = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [refazendo, setRefazendo] = useState(false);
  const lista = (xs: unknown) => (Array.isArray(xs) ? (xs as string[]).join(" · ") : "—");
  async function refazer() {
    setRefazendo(true);
    try {
      await chamarIa("briefing", { sku, forcar: true });
      toast.success("Briefing refeito — refaça o texto e os prompts para usar o novo");
      void qc.invalidateQueries({ queryKey: ["ia-anuncio"] });
    } catch (e) { toast.error("Falha", { description: (e as Error).message }); }
    finally { setRefazendo(false); }
  }
  return (
    <div className="rounded-lg border">
      <button type="button" className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium" onClick={() => setAberto((v) => !v)}>
        {aberto ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}Briefing (o que a IA entendeu do produto)
      </button>
      {aberto && (
        <div className="px-4 pb-3 space-y-1.5 text-sm">
          <p><b>Persona:</b> {briefing.persona ?? "—"}</p>
          <p><b>Dores:</b> {lista(briefing.dores)}</p>
          <p><b>Objeções:</b> {lista(briefing.objecoes)}</p>
          <p><b>Benefícios:</b> {lista(briefing.beneficios)}</p>
          <p><b>Ângulo:</b> {briefing.angulo ?? "—"} · <b>Tom:</b> {briefing.tom ?? "—"}</p>
          <p><b>Palavras-chave:</b> {lista(briefing.palavras_chave)}</p>
          <p><b>Fotos recomendadas:</b> {lista(briefing.fotos_recomendadas)}</p>
          <Button size="sm" variant="outline" className="h-7 mt-1 gap-1" disabled={refazendo} onClick={() => void refazer()}>
            {refazendo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}Refazer briefing
          </Button>
        </div>
      )}
    </div>
  );
}
