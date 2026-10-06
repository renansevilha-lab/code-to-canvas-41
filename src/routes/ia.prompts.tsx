import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Info, Loader2, Sparkles, Star } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import {
  ehBackup, variaveisDoTexto,
  type IaCanalConfig, type IaCanalFaixa, type IaEmpresa, type IaModeloImagem, type IaPromptGuardrail, type IaPromptTemplate,
} from "@/lib/ia";
import { cn } from "@/lib/utils";

// ============================================================================
// /ia/prompts — cadastro dos prompts do gerador de anúncios (porta da tela
// Ajustes do Anúncio Mágico). Fase 1: cópia; a geração ainda roda no gerador,
// que segue sendo a fonte até a Fase 2 (decisão do dono, 06/out/2026).
// ============================================================================

export const Route = createFileRoute("/ia/prompts")({ component: IaPromptsPage });

const QOPTS = { staleTime: 60_000, refetchOnWindowFocus: false } as const;

function IaPromptsPage() {
  return (
    <div className="w-full px-6 md:px-8 py-6 flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-primary" /> Prompts de anúncio (IA)
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Templates, regras e modelos do gerador de anúncios.
        </p>
      </div>
      <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground flex items-start gap-2">
        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-primary" />
        <span>
          Cópia do Anúncio Mágico (Fase 1 da unificação). O gerador ainda usa os prompts <b>de lá</b> — edite lá; esta cópia
          é sincronizada antes da Fase 2, quando a geração passa a rodar aqui.
        </span>
      </div>
      <Tabs defaultValue="templates" className="flex flex-col gap-3">
        <TabsList className="w-fit">
          <TabsTrigger value="templates">Templates</TabsTrigger>
          <TabsTrigger value="regras">Regras</TabsTrigger>
          <TabsTrigger value="modelos">Modelos de imagem</TabsTrigger>
          <TabsTrigger value="canais">Canais</TabsTrigger>
          <TabsTrigger value="empresas">Empresas</TabsTrigger>
        </TabsList>
        <TabsContent value="templates"><TemplatesTab /></TabsContent>
        <TabsContent value="regras"><RegrasTab /></TabsContent>
        <TabsContent value="modelos"><ModelosTab /></TabsContent>
        <TabsContent value="canais"><CanaisTab /></TabsContent>
        <TabsContent value="empresas"><EmpresasTab /></TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------- TEMPLATES ------------------------------- */

function TemplatesTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["ia", "prompt_template"],
    ...QOPTS,
    queryFn: async (): Promise<IaPromptTemplate[]> => {
      const { data, error } = await supabaseExternal.from("ia_prompt_template")
        .select("id,nome,tipo,canal,versao,conteudo,variaveis,modelo,ativo,updated_at").order("tipo").order("nome");
      if (error) throw error;
      return (data ?? []) as IaPromptTemplate[];
    },
  });
  const [verBackups, setVerBackups] = useState(false);
  const [editing, setEditing] = useState<IaPromptTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const lista = (q.data ?? []).filter((p) => verBackups || !ehBackup(p.nome));
  const vars = editing ? variaveisDoTexto(editing.conteudo) : [];

  async function salvar() {
    if (!editing) return;
    setSaving(true);
    const { error } = await supabaseExternal.from("ia_prompt_template")
      .update({ conteudo: editing.conteudo, modelo: editing.modelo, ativo: editing.ativo }).eq("id", editing.id);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Template salvo");
    setEditing(null);
    void qc.invalidateQueries({ queryKey: ["ia", "prompt_template"] });
  }

  return (
    <div className="grid gap-4 md:grid-cols-[300px_1fr]">
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
          <Switch checked={verBackups} onCheckedChange={setVerBackups} /> mostrar backups (inativos)
        </label>
        {q.isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {lista.map((p) => (
          <button key={p.id} type="button" onClick={() => setEditing(p)}
            className={cn("flex w-full flex-col items-start rounded-md border px-2.5 py-1.5 text-left hover:bg-muted/60",
              editing?.id === p.id && "border-primary bg-primary/5", !p.ativo && "opacity-60")}>
            <span className="flex w-full items-center gap-1 text-sm font-medium">
              <span className="truncate">{p.nome}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">v{p.versao}</span>
            </span>
            <span className="text-[10px] uppercase text-muted-foreground">{p.tipo}{p.canal ? ` · ${p.canal}` : ""}</span>
          </button>
        ))}
      </div>
      <div>
        {!editing ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            Selecione um template para ver ou editar.
          </div>
        ) : (
          <Card>
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold">{editing.nome}</span>
                <Badge variant="outline" className="text-[10px]">{editing.tipo}</Badge>
                {editing.canal && <Badge variant="outline" className="text-[10px]">{editing.canal}</Badge>}
                <span className="ml-auto flex items-center gap-2">
                  <Label className="text-xs">Ativo</Label>
                  <Switch checked={editing.ativo} onCheckedChange={(v) => setEditing({ ...editing, ativo: v })} />
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Modelo</Label>
                <Input value={editing.modelo ?? ""} onChange={(e) => setEditing({ ...editing, modelo: e.target.value || null })} className="h-8 text-sm" />
              </div>
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">Conteúdo</Label>
                  <span className="text-[10px] text-muted-foreground">
                    Variáveis: {vars.length ? vars.map((v) => (
                      <code key={v} className="mx-0.5 rounded bg-muted px-1">{`{{${v}}}`}</code>
                    )) : "nenhuma"}
                  </span>
                </div>
                <Textarea rows={18} value={editing.conteudo} onChange={(e) => setEditing({ ...editing, conteudo: e.target.value })}
                  className="font-mono text-xs" />
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  Remover uma variável <code className="bg-muted px-1">{"{{...}}"}</code> quebra o preenchimento.
                </span>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancelar</Button>
                <Button size="sm" onClick={() => void salvar()} disabled={saving}>
                  {saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Salvar
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

/* --------------------------------- REGRAS -------------------------------- */

function RegrasTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["ia", "prompt_guardrail"],
    ...QOPTS,
    queryFn: async (): Promise<IaPromptGuardrail[]> => {
      const { data, error } = await supabaseExternal.from("ia_prompt_guardrail")
        .select("id,nome,escopo,canal,categoria,tipo,padrao,substituto,acao,severidade,ativo").order("nome");
      if (error) throw error;
      return (data ?? []) as IaPromptGuardrail[];
    },
  });
  async function alternar(g: IaPromptGuardrail) {
    const { error } = await supabaseExternal.from("ia_prompt_guardrail").update({ ativo: !g.ativo }).eq("id", g.id);
    if (error) { toast.error(error.message); return; }
    void qc.invalidateQueries({ queryKey: ["ia", "prompt_guardrail"] });
  }
  const instrucoes = (q.data ?? []).filter((g) => g.tipo === "instrucao");
  const outros = (q.data ?? []).filter((g) => g.tipo !== "instrucao");
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ColunaRegras titulo="Instruções · impedem o modelo de inventar" itens={instrucoes} onToggle={alternar} />
      <ColunaRegras titulo="Regex / termo · bloqueio de palavra" itens={outros} onToggle={alternar} />
    </div>
  );
}
function ColunaRegras({ titulo, itens, onToggle }: { titulo: string; itens: IaPromptGuardrail[]; onToggle: (g: IaPromptGuardrail) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{titulo}</span>
      {itens.length === 0 && <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">Nenhuma regra desse tipo.</div>}
      {itens.map((g) => (
        <div key={g.id} className={cn("flex items-start gap-2 rounded-md border p-2", !g.ativo && "opacity-50")}>
          <Switch checked={g.ativo} onCheckedChange={() => onToggle(g)} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 text-sm font-medium flex-wrap">
              <span className="truncate">{g.nome}</span>
              <Badge variant="outline" className="text-[10px]">{g.acao}</Badge>
              {g.escopo !== "global" && <Badge variant="outline" className="text-[10px]">{g.escopo}{g.canal ? `: ${g.canal}` : ""}</Badge>}
            </div>
            {g.padrao && <code className="mt-1 block break-all rounded bg-muted px-1.5 py-0.5 text-[11px] whitespace-pre-wrap">{g.padrao}</code>}
            {g.substituto && <span className="mt-0.5 block text-[11px] text-muted-foreground">→ {g.substituto}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------- MODELOS ------------------------------- */

function ModelosTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["ia", "modelo_imagem"],
    ...QOPTS,
    queryFn: async (): Promise<IaModeloImagem[]> => {
      const { data, error } = await supabaseExternal.from("ia_modelo_imagem")
        .select("id,label,provider,quality,custo_estimado_usd,nota,padrao,ativo,ordem").order("ordem");
      if (error) throw error;
      return (data ?? []) as IaModeloImagem[];
    },
  });
  async function alternar(m: IaModeloImagem) {
    const { error } = await supabaseExternal.from("ia_modelo_imagem").update({ ativo: !m.ativo }).eq("id", m.id);
    if (error) { toast.error(error.message); return; }
    void qc.invalidateQueries({ queryKey: ["ia", "modelo_imagem"] });
  }
  async function definirPadrao(m: IaModeloImagem) {
    // índice único parcial: tira o padrão antigo antes de marcar o novo
    const { error: e1 } = await supabaseExternal.from("ia_modelo_imagem").update({ padrao: false }).neq("id", m.id).eq("padrao", true);
    if (e1) { toast.error(e1.message); return; }
    const { error: e2 } = await supabaseExternal.from("ia_modelo_imagem").update({ padrao: true }).eq("id", m.id);
    if (e2) { toast.error(e2.message); return; }
    toast.success("Modelo padrão atualizado");
    void qc.invalidateQueries({ queryKey: ["ia", "modelo_imagem"] });
  }
  return (
    <div className="rounded-lg border overflow-x-auto">
      <table className="w-full text-sm min-w-[760px]">
        <thead>
          <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
            <th className="py-2 px-3 font-semibold w-16">Ativo</th>
            <th className="py-2 px-3 font-semibold">Modelo</th>
            <th className="py-2 px-3 font-semibold">Provedor</th>
            <th className="py-2 px-3 font-semibold text-right">Custo/foto</th>
            <th className="py-2 px-3 font-semibold">Nota</th>
            <th className="py-2 px-3 font-semibold w-44">Padrão</th>
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((m) => (
            <tr key={m.id} className={cn("border-b last:border-0", !m.ativo && "opacity-50")}>
              <td className="py-1.5 px-3"><Switch checked={m.ativo} onCheckedChange={() => void alternar(m)} /></td>
              <td className="py-1.5 px-3 font-medium">{m.label}<div className="text-[11px] text-muted-foreground font-mono">{m.id}{m.quality ? ` · ${m.quality}` : ""}</div></td>
              <td className="py-1.5 px-3 text-muted-foreground">{m.provider}</td>
              <td className="py-1.5 px-3 text-right font-mono tabular-nums">US$ {Number(m.custo_estimado_usd).toFixed(3)}</td>
              <td className="py-1.5 px-3 text-xs text-muted-foreground">{m.nota ?? "—"}</td>
              <td className="py-1.5 px-3">
                {m.padrao ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                    <Star className="h-3 w-3" /> Padrão atual
                  </span>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void definirPadrao(m)}>Definir como padrão</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------- CANAIS -------------------------------- */

function CanaisTab() {
  const qc = useQueryClient();
  const canaisQ = useQuery({
    queryKey: ["ia", "canal_config"],
    ...QOPTS,
    queryFn: async (): Promise<IaCanalConfig[]> => {
      const { data, error } = await supabaseExternal.from("ia_canal_config")
        .select("id,canal,ativo,qtd_imagens_min,qtd_imagens_max,imagem_largura,imagem_altura,imagem_formato,titulo_max_chars,descricao_max_chars,comissao_pct,margem_alvo_pct,custos_fixos_pct")
        .order("canal");
      if (error) throw error;
      return (data ?? []) as IaCanalConfig[];
    },
  });
  const faixasQ = useQuery({
    queryKey: ["ia", "canal_faixa"],
    ...QOPTS,
    queryFn: async (): Promise<IaCanalFaixa[]> => {
      const { data, error } = await supabaseExternal.from("ia_canal_faixa")
        .select("id,canal,ordem,preco_ate,comissao_pct,tarifa_fixa").order("canal").order("ordem");
      if (error) throw error;
      return (data ?? []) as IaCanalFaixa[];
    },
  });
  const faixasPorCanal = useMemo(() => {
    const m = new Map<string, IaCanalFaixa[]>();
    for (const f of faixasQ.data ?? []) m.set(f.canal, [...(m.get(f.canal) ?? []), f]);
    return m;
  }, [faixasQ.data]);

  async function salvarCanal(canal: string, patch: Partial<IaCanalConfig>) {
    const { error } = await supabaseExternal.from("ia_canal_config").update(patch).eq("canal", canal);
    if (error) { toast.error(error.message); return; }
    toast.success("Canal atualizado");
    void qc.invalidateQueries({ queryKey: ["ia", "canal_config"] });
  }
  async function salvarFaixa(id: string, patch: Partial<IaCanalFaixa>) {
    const { error } = await supabaseExternal.from("ia_canal_faixa").update(patch).eq("id", id);
    if (error) { toast.error(error.message); return; }
    void qc.invalidateQueries({ queryKey: ["ia", "canal_faixa"] });
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs text-muted-foreground">Percentuais em fração (0,25 = 25%). Ainda não usados aqui: entram no preço sugerido da Fase 2.</span>
      {(canaisQ.data ?? []).map((c) => (
        <Card key={c.canal}>
          <CardContent className="p-4 flex flex-col gap-3">
            <span className="text-sm font-semibold">Canal · {c.canal}</span>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <CampoNum rotulo="Margem alvo" valor={c.margem_alvo_pct} onSalvar={(v) => void salvarCanal(c.canal, { margem_alvo_pct: v })} />
              <CampoNum rotulo="Custos fixos" valor={c.custos_fixos_pct} onSalvar={(v) => void salvarCanal(c.canal, { custos_fixos_pct: v })} />
              <CampoNum rotulo="Título máx." valor={c.titulo_max_chars} onSalvar={(v) => void salvarCanal(c.canal, { titulo_max_chars: v })} />
              <CampoNum rotulo="Descrição máx." valor={c.descricao_max_chars} onSalvar={(v) => void salvarCanal(c.canal, { descricao_max_chars: v })} />
              <CampoNum rotulo="Imagem largura" valor={c.imagem_largura} onSalvar={(v) => void salvarCanal(c.canal, { imagem_largura: v })} />
              <CampoNum rotulo="Imagem altura" valor={c.imagem_altura} onSalvar={(v) => void salvarCanal(c.canal, { imagem_altura: v })} />
            </div>
            {(faixasPorCanal.get(c.canal) ?? []).length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Faixas de comissão</span>
                <table className="w-full text-sm max-w-xl">
                  <thead>
                    <tr className="border-b text-left text-[11px] uppercase text-muted-foreground">
                      <th className="py-1">Ordem</th><th className="py-1">Preço até (R$)</th><th className="py-1">Comissão</th><th className="py-1">Tarifa fixa (R$)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(faixasPorCanal.get(c.canal) ?? []).map((f) => (
                      <tr key={f.id} className="border-b last:border-0">
                        <td className="py-1 pr-2 font-mono">{f.ordem}</td>
                        <td className="py-1 pr-2"><CampoNumInline valor={f.preco_ate} placeholder="∞" onSalvar={(v) => void salvarFaixa(f.id, { preco_ate: v })} /></td>
                        <td className="py-1 pr-2"><CampoNumInline valor={f.comissao_pct} onSalvar={(v) => void salvarFaixa(f.id, { comissao_pct: v ?? 0 })} /></td>
                        <td className="py-1 pr-2"><CampoNumInline valor={f.tarifa_fixa} onSalvar={(v) => void salvarFaixa(f.id, { tarifa_fixa: v ?? 0 })} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/* -------------------------------- EMPRESAS ------------------------------- */

function EmpresasTab() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["ia", "empresa"],
    ...QOPTS,
    queryFn: async (): Promise<IaEmpresa[]> => {
      const { data, error } = await supabaseExternal.from("ia_empresa").select("codigo,nome,imposto_pct,ativo").order("codigo");
      if (error) throw error;
      return (data ?? []) as IaEmpresa[];
    },
  });
  async function salvar(codigo: string, patch: Partial<IaEmpresa>) {
    const { error } = await supabaseExternal.from("ia_empresa").update(patch).eq("codigo", codigo);
    if (error) { toast.error(error.message); return; }
    toast.success("Empresa atualizada");
    void qc.invalidateQueries({ queryKey: ["ia", "empresa"] });
  }
  return (
    <div className="max-w-2xl flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">Imposto em fração (0,10 = 10%). Usado no preço sugerido da Fase 2.</span>
      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase text-muted-foreground border-b bg-muted/40">
              <th className="py-2 px-3 font-semibold">Código</th><th className="py-2 px-3 font-semibold">Nome</th><th className="py-2 px-3 font-semibold">Imposto</th>
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((e) => (
              <tr key={e.codigo} className="border-b last:border-0">
                <td className="py-1.5 px-3 font-mono">{e.codigo}</td>
                <td className="py-1.5 px-3">{e.nome}</td>
                <td className="py-1.5 px-3 w-40"><CampoNumInline valor={e.imposto_pct} onSalvar={(v) => void salvar(e.codigo, { imposto_pct: v ?? 0 })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------- campos ---------------------------------- */

function CampoNum({ rotulo, valor, onSalvar }: { rotulo: string; valor: number | null; onSalvar: (v: number) => void }) {
  const [v, setV] = useState(valor != null ? String(valor) : "");
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{rotulo}</Label>
      <Input type="number" step="0.01" value={v} onChange={(e) => setV(e.target.value)} className="h-8 text-sm"
        onBlur={() => { const n = Number(v); if (v !== "" && Number.isFinite(n) && n !== Number(valor)) onSalvar(n); }} />
    </div>
  );
}
function CampoNumInline({ valor, onSalvar, placeholder }: { valor: number | null; onSalvar: (v: number | null) => void; placeholder?: string }) {
  const [v, setV] = useState(valor != null ? String(valor) : "");
  return (
    <Input type="number" step="0.01" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} className="h-7 text-sm"
      onBlur={() => {
        if (v === "") { if (valor != null) onSalvar(null); return; }
        const n = Number(v);
        if (Number.isFinite(n) && n !== Number(valor)) onSalvar(n);
      }} />
  );
}
