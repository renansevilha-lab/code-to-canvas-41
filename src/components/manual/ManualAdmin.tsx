import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2, Save } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { type ErroCatalogo, type Item, type Membro, type Secao, NOMES_DIAS } from "@/lib/manual";

// ============================================================================
// Modo edição do Manual (só para perfil com módulo `todos`).
// Edição inline: cada linha tem seus campos e um "Salvar". Nada de wizard —
// é ferramenta de manutenção, usada de vez em quando.
//
// "Desativar" em vez de apagar: manter o histórico de manual_progresso válido
// (apagar item apaga o progresso em cascata).
// ============================================================================

type Props = {
  membros: Membro[];
  secoes: Secao[];
  itens: Item[];
  onMudou: () => void;
};

export function ManualAdmin({ membros, secoes, itens, onMudou }: Props) {
  return (
    <Tabs defaultValue="itens">
      <TabsList>
        <TabsTrigger value="itens">Itens</TabsTrigger>
        <TabsTrigger value="secoes">Seções</TabsTrigger>
        <TabsTrigger value="equipe">Equipe</TabsTrigger>
        <TabsTrigger value="erros">Erros</TabsTrigger>
      </TabsList>

      <TabsContent value="itens" className="mt-4">
        <AbaItens membros={membros} secoes={secoes} itens={itens} onMudou={onMudou} />
      </TabsContent>
      <TabsContent value="secoes" className="mt-4">
        <AbaSecoes membros={membros} secoes={secoes} onMudou={onMudou} />
      </TabsContent>
      <TabsContent value="equipe" className="mt-4">
        <AbaEquipe membros={membros} onMudou={onMudou} />
      </TabsContent>
      <TabsContent value="erros" className="mt-4">
        <AbaErros />
      </TabsContent>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// ITENS
// ---------------------------------------------------------------------------
function AbaItens({ membros, secoes, itens, onMudou }: Props) {
  const [secaoSel, setSecaoSel] = useState(secoes[0]?.code ?? "");
  const daSecao = itens.filter((i) => i.secao_code === secaoSel);
  const secao = secoes.find((s) => s.code === secaoSel);

  async function criar() {
    if (!secao) return;
    const { error } = await supabaseExternal.from("manual_itens").insert({
      secao_code: secao.code,
      tipo: secao.tipo === "rotina" ? "check" : "check",
      texto: "Novo item",
      turno: secao.tipo === "rotina" ? "inicio" : null,
      ordem: (daSecao.at(-1)?.ordem ?? 0) + 1,
    });
    if (error) return toast.error("Falha ao criar", { description: error.message });
    toast.success("Item criado");
    onMudou();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {secoes.map((s) => (
          <button
            key={s.code}
            onClick={() => setSecaoSel(s.code)}
            className={cn(
              "px-3 py-1.5 text-sm rounded-full border transition-colors",
              secaoSel === s.code ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted",
            )}
          >
            {s.code} · {s.titulo}
          </button>
        ))}
      </div>

      <Button variant="outline" size="sm" className="h-9 gap-2 self-start" onClick={() => void criar()}>
        <Plus className="h-3.5 w-3.5" /> Novo item nesta seção
      </Button>

      {daSecao.map((item) => (
        <LinhaItemAdmin
          key={item.id}
          item={item}
          membros={membros}
          secoes={secoes}
          onMudou={onMudou}
        />
      ))}
    </div>
  );
}

function LinhaItemAdmin({
  item, membros, secoes, onMudou,
}: { item: Item; membros: Membro[]; secoes: Secao[]; onMudou: () => void }) {
  const [f, setF] = useState({
    texto: item.texto,
    secao_code: item.secao_code,
    tipo: item.tipo,
    turno: item.turno ?? "",
    responsavel_id: item.responsavel_id ?? "",
    tags: (item.tags ?? []).join(", "),
    dias: item.dias ?? null,
    abre_quando: item.abre_quando ?? "nao",
    campo_label: item.campo_label ?? "Descreva",
    ordem: item.ordem,
  });
  const [salvando, setSalvando] = useState(false);

  function alternarDia(d: number) {
    setF((v) => {
      const atual = v.dias ?? [];
      const novo = atual.includes(d) ? atual.filter((x) => x !== d) : [...atual, d].sort();
      return { ...v, dias: novo.length === 0 ? null : novo };
    });
  }

  async function salvar() {
    setSalvando(true);
    const { error } = await supabaseExternal
      .from("manual_itens")
      .update({
        texto: f.texto,
        secao_code: f.secao_code,
        tipo: f.tipo,
        turno: f.turno === "" ? null : f.turno,
        responsavel_id: f.responsavel_id === "" ? null : f.responsavel_id,
        tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
        dias: f.dias,
        abre_quando: f.abre_quando,
        campo_label: f.campo_label,
        ordem: f.ordem,
      })
      .eq("id", item.id);
    setSalvando(false);
    if (error) return toast.error("Falha ao salvar", { description: error.message });
    toast.success("Item salvo");
    onMudou();
  }

  async function desativar() {
    // Grava a data: sem ela o Histórico não saberia até quando o item valia e
    // passaria a cobrá-lo (ou a escondê-lo) nos dias errados.
    const { error } = await supabaseExternal
      .from("manual_itens")
      .update({ ativo: false, desativado_em: new Date().toISOString() })
      .eq("id", item.id);
    if (error) return toast.error("Falha ao remover", { description: error.message });
    toast.success("Item removido da lista", {
      description: "O histórico dos dias anteriores continua mostrando este item.",
    });
    onMudou();
  }

  return (
    <Card className="p-4 flex flex-col gap-3">
      <Textarea
        value={f.texto}
        onChange={(e) => setF({ ...f, texto: e.target.value })}
        rows={2}
        className="text-sm"
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Campo label="Seção">
          <select
            value={f.secao_code}
            onChange={(e) => setF({ ...f, secao_code: e.target.value })}
            className="w-full h-9 rounded-md border bg-background px-2 text-sm"
          >
            {secoes.map((s) => (
              <option key={s.code} value={s.code}>{s.code}</option>
            ))}
          </select>
        </Campo>

        <Campo label="Tipo">
          <select
            value={f.tipo}
            onChange={(e) => setF({ ...f, tipo: e.target.value as Item["tipo"] })}
            className="w-full h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="check">Check</option>
            <option value="pergunta">Pergunta</option>
          </select>
        </Campo>

        <Campo label="Turno">
          <select
            value={f.turno}
            onChange={(e) => setF({ ...f, turno: e.target.value as "inicio" | "fim" | "" })}
            className="w-full h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">— (processo)</option>
            <option value="inicio">Matinal</option>
            <option value="fim">Encerramento</option>
          </select>
        </Campo>

        <Campo label="Responsável">
          <select
            value={f.responsavel_id}
            onChange={(e) => setF({ ...f, responsavel_id: e.target.value })}
            className="w-full h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Herda da seção</option>
            {membros.map((m) => (
              <option key={m.id} value={m.id}>{m.nome}</option>
            ))}
          </select>
        </Campo>

        <Campo label="Tags (vírgula)">
          <Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} className="h-9" />
        </Campo>

        <Campo label="Ordem">
          <Input
            type="number"
            value={f.ordem}
            onChange={(e) => setF({ ...f, ordem: Number(e.target.value) })}
            className="h-9"
          />
        </Campo>

        {f.tipo === "pergunta" && (
          <>
            <Campo label="Abre campo quando">
              <select
                value={f.abre_quando}
                onChange={(e) => setF({ ...f, abre_quando: e.target.value as "sim" | "nao" | "nunca" })}
                className="w-full h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="nao">Resposta = Não</option>
                <option value="sim">Resposta = Sim</option>
                <option value="nunca">Nunca (só Sim/Não)</option>
              </select>
            </Campo>
            <Campo label="Rótulo do campo">
              <Input
                value={f.campo_label}
                onChange={(e) => setF({ ...f, campo_label: e.target.value })}
                className="h-9"
              />
            </Campo>
          </>
        )}
      </div>

      <div>
        <span className="text-xs text-muted-foreground">
          Dias (nenhum marcado = todo dia)
        </span>
        <div className="flex flex-wrap gap-1.5 mt-1">
          {NOMES_DIAS.map((nome, d) => (
            <button
              key={d}
              onClick={() => alternarDia(d)}
              className={cn(
                "px-2.5 py-1 text-xs rounded-md border transition-colors",
                (f.dias ?? []).includes(d)
                  ? "bg-primary text-primary-foreground border-primary"
                  : "hover:bg-muted",
              )}
            >
              {nome}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" className="h-8 gap-1.5" disabled={salvando} onClick={() => void salvar()}>
          {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Salvar
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-destructive" onClick={() => void desativar()}>
          <Trash2 className="h-3.5 w-3.5" /> Remover
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SEÇÕES
// ---------------------------------------------------------------------------
function AbaSecoes({
  membros, secoes, onMudou,
}: { membros: Membro[]; secoes: Secao[]; onMudou: () => void }) {
  const [novoCode, setNovoCode] = useState("");

  async function criar() {
    const code = novoCode.trim().toUpperCase();
    if (!code) return toast.error("Informe o código (ex.: RESP-07)");
    const { error } = await supabaseExternal.from("manual_secoes").insert({
      code, tipo: "processo", titulo: "Nova seção", ordem: (secoes.at(-1)?.ordem ?? 0) + 1,
    });
    if (error) return toast.error("Falha ao criar", { description: error.message });
    setNovoCode("");
    toast.success("Seção criada");
    onMudou();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Código da nova seção (RESP-07)"
          value={novoCode}
          onChange={(e) => setNovoCode(e.target.value)}
          className="h-9 max-w-[260px]"
        />
        <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => void criar()}>
          <Plus className="h-3.5 w-3.5" /> Criar
        </Button>
      </div>

      {secoes.map((s) => (
        <LinhaSecaoAdmin key={s.code} secao={s} membros={membros} onMudou={onMudou} />
      ))}
    </div>
  );
}

function LinhaSecaoAdmin({
  secao, membros, onMudou,
}: { secao: Secao; membros: Membro[]; onMudou: () => void }) {
  const [f, setF] = useState({
    titulo: secao.titulo,
    tipo: secao.tipo,
    descricao: secao.descricao ?? "",
    frequencia: secao.frequencia ?? "",
    responsavel_id: secao.responsavel_id ?? "",
    ordem: secao.ordem,
    callouts: JSON.stringify(secao.callouts ?? [], null, 0),
    tabela_ref: secao.tabela_ref ? JSON.stringify(secao.tabela_ref) : "",
  });
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    // JSON malformado aqui viraria erro 400 do PostgREST; melhor avisar antes.
    let callouts: unknown = [];
    let tabela: unknown = null;
    try {
      callouts = f.callouts.trim() ? JSON.parse(f.callouts) : [];
      tabela = f.tabela_ref.trim() ? JSON.parse(f.tabela_ref) : null;
    } catch {
      return toast.error("JSON inválido em callouts ou tabela de referência");
    }

    setSalvando(true);
    const { error } = await supabaseExternal
      .from("manual_secoes")
      .update({
        titulo: f.titulo,
        tipo: f.tipo,
        descricao: f.descricao || null,
        frequencia: f.frequencia || null,
        responsavel_id: f.responsavel_id === "" ? null : f.responsavel_id,
        ordem: f.ordem,
        callouts,
        tabela_ref: tabela,
      })
      .eq("code", secao.code);
    setSalvando(false);
    if (error) return toast.error("Falha ao salvar", { description: error.message });
    toast.success("Seção salva");
    onMudou();
  }

  async function desativar() {
    const { error } = await supabaseExternal.from("manual_secoes").update({ ativo: false }).eq("code", secao.code);
    if (error) return toast.error("Falha ao remover", { description: error.message });
    toast.success("Seção removida da lista");
    onMudou();
  }

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono text-[10px]">{secao.code}</Badge>
        <Input value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} className="h-9" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Campo label="Tipo">
          <select
            value={f.tipo}
            onChange={(e) => setF({ ...f, tipo: e.target.value as Secao["tipo"] })}
            className="w-full h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="rotina">Rotina (checklist)</option>
            <option value="processo">Processo (documentação)</option>
          </select>
        </Campo>
        <Campo label="Responsável">
          <select
            value={f.responsavel_id}
            onChange={(e) => setF({ ...f, responsavel_id: e.target.value })}
            className="w-full h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="">—</option>
            {membros.map((m) => (
              <option key={m.id} value={m.id}>{m.nome}</option>
            ))}
          </select>
        </Campo>
        <Campo label="Frequência">
          <Input value={f.frequencia} onChange={(e) => setF({ ...f, frequencia: e.target.value })} className="h-9" />
        </Campo>
        <Campo label="Ordem">
          <Input
            type="number"
            value={f.ordem}
            onChange={(e) => setF({ ...f, ordem: Number(e.target.value) })}
            className="h-9"
          />
        </Campo>
      </div>

      <Campo label="Descrição">
        <Textarea value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} rows={2} />
      </Campo>
      <Campo label='Callouts (JSON: [{"tipo":"warn","texto":"…"}])'>
        <Textarea value={f.callouts} onChange={(e) => setF({ ...f, callouts: e.target.value })} rows={2} className="font-mono text-xs" />
      </Campo>
      <Campo label='Tabela de referência (JSON: {"head":[…],"rows":[[…]]}) — vazio = nenhuma'>
        <Textarea value={f.tabela_ref} onChange={(e) => setF({ ...f, tabela_ref: e.target.value })} rows={2} className="font-mono text-xs" />
      </Campo>

      <div className="flex items-center gap-2">
        <Button size="sm" className="h-8 gap-1.5" disabled={salvando} onClick={() => void salvar()}>
          {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Salvar
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-destructive" onClick={() => void desativar()}>
          <Trash2 className="h-3.5 w-3.5" /> Remover
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// EQUIPE
// ---------------------------------------------------------------------------
function AbaEquipe({ membros, onMudou }: { membros: Membro[]; onMudou: () => void }) {
  const [novo, setNovo] = useState({ id: "", nome: "" });

  async function criar() {
    const id = novo.id.trim().toLowerCase();
    if (!id || !novo.nome.trim()) return toast.error("Informe o apelido (id) e o nome");
    const { error } = await supabaseExternal.from("equipe_membros").insert({
      id, nome: novo.nome.trim(), ordem: (membros.at(-1)?.ordem ?? 0) + 1,
    });
    if (error) return toast.error("Falha ao criar", { description: error.message });
    setNovo({ id: "", nome: "" });
    toast.success("Membro criado");
    onMudou();
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="apelido (ex.: joao)"
          value={novo.id}
          onChange={(e) => setNovo({ ...novo, id: e.target.value })}
          className="h-9 max-w-[180px]"
        />
        <Input
          placeholder="Nome"
          value={novo.nome}
          onChange={(e) => setNovo({ ...novo, nome: e.target.value })}
          className="h-9 max-w-[220px]"
        />
        <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => void criar()}>
          <Plus className="h-3.5 w-3.5" /> Criar
        </Button>
      </div>

      {membros.map((m) => (
        <LinhaMembroAdmin key={m.id} membro={m} onMudou={onMudou} />
      ))}
    </div>
  );
}

function LinhaMembroAdmin({ membro, onMudou }: { membro: Membro; onMudou: () => void }) {
  const [f, setF] = useState({
    nome: membro.nome,
    cor: membro.cor,
    email: membro.email ?? "",
    ordem: membro.ordem,
  });
  const [salvando, setSalvando] = useState(false);

  async function salvar() {
    setSalvando(true);
    const { error } = await supabaseExternal
      .from("equipe_membros")
      .update({
        nome: f.nome,
        cor: f.cor,
        // e-mail vazio precisa virar null: a coluna é UNIQUE e '' repetiria.
        email: f.email.trim() ? f.email.trim().toLowerCase() : null,
        ordem: f.ordem,
      })
      .eq("id", membro.id);
    setSalvando(false);
    if (error) return toast.error("Falha ao salvar", { description: error.message });
    toast.success("Membro salvo");
    onMudou();
  }

  async function desativar() {
    const { error } = await supabaseExternal.from("equipe_membros").update({ ativo: false }).eq("id", membro.id);
    if (error) return toast.error("Falha ao remover", { description: error.message });
    toast.success("Membro removido da lista");
    onMudou();
  }

  return (
    <Card className="p-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
        <Campo label="Apelido (id)">
          <Input value={membro.id} disabled className="h-9 font-mono text-xs" />
        </Campo>
        <Campo label="Nome">
          <Input value={f.nome} onChange={(e) => setF({ ...f, nome: e.target.value })} className="h-9" />
        </Campo>
        <Campo label="Cor">
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={f.cor}
              onChange={(e) => setF({ ...f, cor: e.target.value })}
              className="h-9 w-12 rounded border bg-background"
            />
            <Input value={f.cor} onChange={(e) => setF({ ...f, cor: e.target.value })} className="h-9 font-mono text-xs" />
          </div>
        </Campo>
        <Campo label="E-mail do login (liga automático)">
          <Input
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            placeholder="nome@ottzpet.com.br"
            className="h-9"
          />
        </Campo>
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-9 gap-1.5" disabled={salvando} onClick={() => void salvar()}>
            {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Salvar
          </Button>
          <Button size="sm" variant="ghost" className="h-9 text-destructive" onClick={() => void desativar()}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// ERROS (catálogo da tela "Solução de problemas")
// ---------------------------------------------------------------------------
function AbaErros() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["manual", "erros"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("erros_catalogo").select("*").eq("ativo", true).order("ordem");
      if (error) throw error;
      return (data ?? []) as ErroCatalogo[];
    },
  });
  const recarregar = () => void qc.invalidateQueries({ queryKey: ["manual", "erros"] });

  async function criar() {
    const { error } = await supabaseExternal.from("erros_catalogo").insert({
      titulo: "Novo erro", ordem: ((q.data ?? []).at(-1)?.ordem ?? 0) + 1,
    });
    if (error) return toast.error("Falha ao criar", { description: error.message });
    toast.success("Erro criado");
    recarregar();
  }

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Carregando…</p>;

  return (
    <div className="flex flex-col gap-3">
      <Button variant="outline" size="sm" className="h-9 gap-2 self-start" onClick={() => void criar()}>
        <Plus className="h-3.5 w-3.5" /> Novo erro
      </Button>
      {(q.data ?? []).length === 0 && (
        <Card className="p-6 text-sm text-muted-foreground text-center">
          Nenhum erro cadastrado. Crie o primeiro acima — ou cole o conteúdo do manual antigo.
        </Card>
      )}
      {(q.data ?? []).map((e) => (
        <LinhaErroAdmin key={e.id} erro={e} onMudou={recarregar} />
      ))}
    </div>
  );
}

function LinhaErroAdmin({ erro, onMudou }: { erro: ErroCatalogo; onMudou: () => void }) {
  const [f, setF] = useState({
    titulo: erro.titulo,
    tags: (erro.tags ?? []).join(", "),
    // Listas editadas como uma linha por item — mais simples que JSON na mão.
    sintomas: (erro.sintomas ?? []).join("\n"),
    solucao: (erro.solucao ?? []).join("\n"),
    teste_rapido: erro.teste_rapido ?? "",
    causa_raiz: erro.causa_raiz ?? "",
    como_confirmar: erro.como_confirmar ?? "",
    quando_escalar: erro.quando_escalar ?? "",
    prevencao: erro.prevencao ?? "",
    ordem: erro.ordem,
  });
  const [salvando, setSalvando] = useState(false);
  const linhas = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

  async function salvar() {
    setSalvando(true);
    const { error } = await supabaseExternal
      .from("erros_catalogo")
      .update({
        titulo: f.titulo,
        tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
        sintomas: linhas(f.sintomas),
        solucao: linhas(f.solucao),
        teste_rapido: f.teste_rapido || null,
        causa_raiz: f.causa_raiz || null,
        como_confirmar: f.como_confirmar || null,
        quando_escalar: f.quando_escalar || null,
        prevencao: f.prevencao || null,
        ordem: f.ordem,
      })
      .eq("id", erro.id);
    setSalvando(false);
    if (error) return toast.error("Falha ao salvar", { description: error.message });
    toast.success("Erro salvo");
    onMudou();
  }

  async function desativar() {
    const { error } = await supabaseExternal.from("erros_catalogo").update({ ativo: false }).eq("id", erro.id);
    if (error) return toast.error("Falha ao remover", { description: error.message });
    toast.success("Erro removido da lista");
    onMudou();
  }

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input value={f.titulo} onChange={(e) => setF({ ...f, titulo: e.target.value })} className="h-9" />
        <Input
          type="number"
          value={f.ordem}
          onChange={(e) => setF({ ...f, ordem: Number(e.target.value) })}
          className="h-9 w-20"
        />
      </div>
      <Campo label="Tags (vírgula)">
        <Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} className="h-9" />
      </Campo>
      <Campo label="Sintomas (uma linha por item)">
        <Textarea value={f.sintomas} onChange={(e) => setF({ ...f, sintomas: e.target.value })} rows={3} />
      </Campo>
      <Campo label="Teste rápido">
        <Textarea value={f.teste_rapido} onChange={(e) => setF({ ...f, teste_rapido: e.target.value })} rows={2} />
      </Campo>
      <Campo label="Causa raiz">
        <Textarea value={f.causa_raiz} onChange={(e) => setF({ ...f, causa_raiz: e.target.value })} rows={2} />
      </Campo>
      <Campo label="Solução (uma linha por passo — vira lista numerada)">
        <Textarea value={f.solucao} onChange={(e) => setF({ ...f, solucao: e.target.value })} rows={4} />
      </Campo>
      <Campo label="Como confirmar">
        <Textarea value={f.como_confirmar} onChange={(e) => setF({ ...f, como_confirmar: e.target.value })} rows={2} />
      </Campo>
      <Campo label="Quando escalar">
        <Textarea value={f.quando_escalar} onChange={(e) => setF({ ...f, quando_escalar: e.target.value })} rows={2} />
      </Campo>
      <Campo label="Prevenção">
        <Textarea value={f.prevencao} onChange={(e) => setF({ ...f, prevencao: e.target.value })} rows={2} />
      </Campo>

      <div className="flex items-center gap-2">
        <Button size="sm" className="h-8 gap-1.5" disabled={salvando} onClick={() => void salvar()}>
          {salvando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Salvar
        </Button>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-destructive" onClick={() => void desativar()}>
          <Trash2 className="h-3.5 w-3.5" /> Remover
        </Button>
      </div>
    </Card>
  );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
