import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { format, parseISO, startOfMonth, addMonths } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Target, Trash2, Pencil, Info } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import { formatBRL, formatPercent } from "@/lib/format";

export const Route = createFileRoute("/metas")({
  component: MetasPage,
});

type Marketplace = "todos" | "shopee" | "mercadolivre" | "amazon";
type Tipo = "receita" | "margem" | "acos";

type MetaRow = {
  competencia: string;
  marketplace: Marketplace;
  tipo: Tipo;
  valor: number;
  observacao: string | null;
};

const MARKETPLACES: { value: Marketplace; label: string }[] = [
  { value: "todos", label: "Todos os canais" },
  { value: "shopee", label: "Shopee" },
  { value: "mercadolivre", label: "Mercado Livre" },
  { value: "amazon", label: "Amazon" },
];

const TIPO_LABEL: Record<Tipo, string> = {
  receita: "Receita",
  margem: "Margem de contribuição",
  acos: "Teto de ACOS",
};

function competenciaAtual(): string {
  return format(startOfMonth(new Date()), "yyyy-MM-dd");
}

function labelCompetencia(iso: string) {
  return format(parseISO(iso), "MMMM 'de' yyyy", { locale: ptBR });
}

function MetasPage() {
  const [competencia, setCompetencia] = useState<string>(competenciaAtual());
  const [marketplace, setMarketplace] = useState<Marketplace>("todos");

  const [receita, setReceita] = useState<string>("");
  const [margem, setMargem] = useState<string>("");
  const [acos, setAcos] = useState<string>("");
  const [saving, setSaving] = useState(false);

  const [todas, setTodas] = useState<MetaRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setErro(null);
    try {
      const { data, error } = await supabaseExternal
        .from("metas")
        .select("competencia,marketplace,tipo,valor,observacao")
        .order("competencia", { ascending: false })
        .order("marketplace")
        .order("tipo");
      if (error) throw error;
      // Ignora registros legados com tipo = 'ads' (substituído por 'acos')
      const filtered = ((data ?? []) as MetaRow[]).filter(
        (r) => r.tipo === "receita" || r.tipo === "margem" || r.tipo === "acos",
      );
      setTodas(filtered);
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const found = todas.filter(
      (m) => m.competencia === competencia && m.marketplace === marketplace,
    );
    setReceita(found.find((m) => m.tipo === "receita")?.valor.toString() ?? "");
    setMargem(found.find((m) => m.tipo === "margem")?.valor.toString() ?? "");
    setAcos(found.find((m) => m.tipo === "acos")?.valor.toString() ?? "");
  }, [competencia, marketplace, todas]);

  const opcoesCompetencia = useMemo(() => {
    const base = startOfMonth(new Date());
    const meses: string[] = [];
    for (let i = -6; i <= 6; i++) {
      meses.push(format(addMonths(base, i), "yyyy-MM-dd"));
    }
    for (const m of todas) {
      if (!meses.includes(m.competencia)) meses.push(m.competencia);
    }
    return meses.sort().reverse();
  }, [todas]);

  const salvar = async () => {
    setSaving(true);
    try {
      const parse = (v: string) => {
        const n = Number(v.replace(",", "."));
        return Number.isFinite(n) && n > 0 ? n : null;
      };
      const rows: MetaRow[] = [];
      const push = (tipo: Tipo, v: string) => {
        const n = parse(v);
        if (n !== null) {
          rows.push({ competencia, marketplace, tipo, valor: n, observacao: null });
        }
      };
      push("receita", receita);
      push("margem", margem);
      push("acos", acos);

      if (rows.length === 0) {
        toast.error("Informe pelo menos uma meta.");
        return;
      }

      const { error } = await supabaseExternal
        .from("metas")
        .upsert(rows, { onConflict: "competencia,marketplace,tipo" });
      if (error) throw error;
      toast.success("Metas salvas.");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const excluir = async (row: MetaRow) => {
    if (!confirm(`Remover meta de ${TIPO_LABEL[row.tipo]} · ${labelCompetencia(row.competencia)} · ${row.marketplace}?`)) return;
    try {
      const { error } = await supabaseExternal
        .from("metas")
        .delete()
        .eq("competencia", row.competencia)
        .eq("marketplace", row.marketplace)
        .eq("tipo", row.tipo);
      if (error) throw error;
      toast.success("Meta removida.");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const editar = (row: MetaRow) => {
    setCompetencia(row.competencia);
    setMarketplace(row.marketplace);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const formatValor = (row: MetaRow) =>
    row.tipo === "acos" ? formatPercent(Number(row.valor)) : formatBRL(Number(row.valor));

  return (
    <div className="p-6 md:p-10 max-w-5xl mx-auto space-y-8">
      <header className="space-y-3">
        <Badge variant="secondary" className="gap-1.5">
          <Target className="h-3 w-3" />
          Metas mensais
        </Badge>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Metas</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Defina metas mensais de receita, margem de contribuição e teto de ACOS.
          As metas alimentam o dashboard principal.
        </p>
      </header>

      <Card className="p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Competência (mês)</Label>
            <Select value={competencia} onValueChange={setCompetencia}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {opcoesCompetencia.map((m) => (
                  <SelectItem key={m} value={m}>{labelCompetencia(m)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Canal</Label>
            <Select value={marketplace} onValueChange={(v) => setMarketplace(v as Marketplace)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {MARKETPLACES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-1.5">
            <Label>Meta de Receita (R$)</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={receita}
              onChange={(e) => setReceita(e.target.value)}
              placeholder="0,00"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Meta de Margem de Contribuição (R$)</Label>
            <Input
              type="number"
              inputMode="decimal"
              value={margem}
              onChange={(e) => setMargem(e.target.value)}
              placeholder="0,00"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Teto de ACOS (%)</Label>
            <div className="relative">
              <Input
                type="number"
                inputMode="decimal"
                step="0.1"
                value={acos}
                onChange={(e) => setAcos(e.target.value)}
                placeholder="ex: 8"
                className="pr-8"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
          <Info className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <span>
            <strong>ACOS = gasto com ADS ÷ receita.</strong> É um teto — ficar abaixo é bom.
            No dashboard, a cor é invertida: verde quando o ACOS está abaixo do teto.
          </span>
        </div>

        <div className="flex justify-end">
          <Button onClick={salvar} disabled={saving}>
            {saving ? "Salvando…" : "Salvar metas"}
          </Button>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold">Metas cadastradas</h2>
          <span className="text-xs text-muted-foreground">{todas.length} registros</span>
        </div>
        {erro ? (
          <p className="text-sm text-destructive">{erro}</p>
        ) : loading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : todas.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma meta cadastrada.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Mês</TableHead>
                <TableHead>Canal</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {todas.map((r) => (
                <TableRow key={`${r.competencia}-${r.marketplace}-${r.tipo}`}>
                  <TableCell>{labelCompetencia(r.competencia)}</TableCell>
                  <TableCell className="capitalize">{r.marketplace}</TableCell>
                  <TableCell>{TIPO_LABEL[r.tipo]}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatValor(r)}</TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button size="icon" variant="ghost" onClick={() => editar(r)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" onClick={() => excluir(r)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <MetasAdsCard />
    </div>
  );
}

// ─── Metas de ADS (config_roas_faixas) ────────────────────────────────────

function MetasAdsCard() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [excelente, setExcelente] = useState("");
  const [bom, setBom] = useState("");
  const [ok, setOk] = useState("");
  const [acosAlvo, setAcosAlvo] = useState("");
  const [erro, setErro] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabaseExternal
        .from("config_roas_faixas")
        .select("roas_excelente,roas_bom,roas_ok,acos_alvo")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        setExcelente(String(data.roas_excelente));
        setBom(String(data.roas_bom));
        setOk(String(data.roas_ok));
        setAcosAlvo(String(data.acos_alvo));
      }
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const parse = (v: string) => {
    const n = Number(v.replace(",", "."));
    return Number.isFinite(n) ? n : NaN;
  };

  const salvar = async () => {
    const e = parse(excelente), b = parse(bom), o = parse(ok), a = parse(acosAlvo);
    if ([e, b, o, a].some((n) => Number.isNaN(n) || n <= 0)) {
      toast.error("Preencha todos os campos com valores maiores que zero.");
      return;
    }
    if (!(e >= b && b >= o)) {
      toast.error("As faixas precisam obedecer: excelente ≥ bom ≥ ok.");
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabaseExternal
        .from("config_roas_faixas")
        .upsert(
          { id: 1, roas_excelente: e, roas_bom: b, roas_ok: o, acos_alvo: a },
          { onConflict: "id" },
        );
      if (error) throw error;
      toast.success("Metas de ADS salvas. Os selos serão atualizados automaticamente.");
      await load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6 space-y-6">
      <div className="space-y-1">
        <h2 className="font-semibold flex items-center gap-2">
          <Target className="h-4 w-4" /> Metas de ADS
        </h2>
        <p className="text-xs text-muted-foreground">
          Faixas de ROAS usadas para classificar cada anúncio e teto de ACOS usado nos alertas.
        </p>
      </div>

      {erro && <p className="text-sm text-destructive">{erro}</p>}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="space-y-1.5">
          <Label>ROAS Excelente ≥</Label>
          <div className="relative">
            <Input type="number" step="0.1" value={excelente}
              onChange={(e) => setExcelente(e.target.value)} disabled={loading} className="pr-8" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">x</span>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>ROAS Bom ≥</Label>
          <div className="relative">
            <Input type="number" step="0.1" value={bom}
              onChange={(e) => setBom(e.target.value)} disabled={loading} className="pr-8" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">x</span>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>ROAS OK ≥</Label>
          <div className="relative">
            <Input type="number" step="0.1" value={ok}
              onChange={(e) => setOk(e.target.value)} disabled={loading} className="pr-8" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">x</span>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Teto de ACOS</Label>
          <div className="relative">
            <Input type="number" step="0.1" value={acosAlvo}
              onChange={(e) => setAcosAlvo(e.target.value)} disabled={loading} className="pr-8" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-muted-foreground">
        <Info className="h-4 w-4 text-warning shrink-0 mt-0.5" />
        <span>
          Regra: <strong>excelente ≥ bom ≥ ok</strong>. Abaixo de "ok" → ruim.
          Anúncios com gasto e sem venda ficam como "sem dado".
        </span>
      </div>

      <div className="flex justify-end">
        <Button onClick={salvar} disabled={saving || loading}>
          {saving ? "Salvando…" : "Salvar faixas"}
        </Button>
      </div>
    </Card>
  );
}

