import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Copy, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { supabaseExternal } from "@/integrations/supabase/external-client";
import {
  type Item, type Membro, type Progresso, type Secao,
  dataExtensoDe, diaSemanaDe, exigeDetalhe, faltaDetalhe, hojeSP, horaCurtaSP,
  itemCompleto, montarRelatorio, responsavelDe, rodaHoje, somarDias, vigenteEm,
} from "@/lib/manual";

// ============================================================================
// Histórico do Checklist — visão do administrador.
//
// Duas perguntas que o painel do dia não responde: "o time fechou o dia?" e
// "o que ficou pendente e por quê?". Aqui dá para navegar por qualquer data e
// ver a resposta com o detalhe que a pessoa escreveu.
//
// Cuidado central: a estrutura muda com o tempo. Um item criado hoje NÃO pode
// aparecer como pendente num dia da semana passada — por isso `vigenteEm`
// (manual_itens.criado_em / desativado_em). E os itens são buscados SEM o
// filtro `ativo`, senão um item removido sumiria dos dias em que valia.
// ============================================================================

const DIAS_RESUMO = 14;

type Props = { membros: Membro[]; secoes: Secao[] };

export function HistoricoChecklist({ membros, secoes }: Props) {
  const [dia, setDia] = useState(hojeSP());
  const desde = somarDias(dia, -(DIAS_RESUMO - 1));

  // Itens SEM filtro de ativo: o histórico precisa dos removidos também.
  const itensQuery = useQuery({
    queryKey: ["manual", "historico", "itens"],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("manual_itens")
        .select("*")
        .order("ordem");
      if (error) throw error;
      return (data ?? []) as Item[];
    },
  });

  // Janela curta de propósito: 14 dias x ~12 itens fica bem abaixo do corte de
  // 1.000 linhas do PostgREST. Ampliar exige agregar no banco.
  const progressoQuery = useQuery({
    queryKey: ["manual", "historico", "progresso", desde, dia],
    queryFn: async () => {
      const { data, error } = await supabaseExternal
        .from("manual_progresso")
        .select("*")
        .gte("dia", desde)
        .lte("dia", dia);
      if (error) throw error;
      return (data ?? []) as Progresso[];
    },
  });

  const itens = itensQuery.data ?? [];
  const progresso = progressoQuery.data ?? [];
  const secaoDe = useMemo(() => new Map(secoes.map((s) => [s.code, s])), [secoes]);

  /** Itens de rotina que valiam naquela data (vigência + dia da semana). */
  const itensDoDia = (d: string) => {
    const dow = diaSemanaDe(d);
    return itens.filter((i) => {
      const s = secaoDe.get(i.secao_code);
      if (s?.tipo !== "rotina") return false;
      if (!vigenteEm(i, d)) return false;
      return rodaHoje(i, dow);
    });
  };

  const progressoDoDia = (d: string) => {
    const mapa = new Map<string, Progresso>();
    for (const p of progresso) if (p.dia === d) mapa.set(p.item_id, p);
    return mapa;
  };

  // ---- resumo dos últimos dias ----
  const serie = useMemo(() => {
    const linhas: { dia: string; total: number; feitos: number; pct: number }[] = [];
    for (let k = DIAS_RESUMO - 1; k >= 0; k--) {
      const d = somarDias(dia, -k);
      const doDia = itensDoDia(d);
      const prog = progressoDoDia(d);
      const feitos = doDia.filter((i) => itemCompleto(i, prog.get(i.id))).length;
      linhas.push({
        dia: d,
        total: doDia.length,
        feitos,
        pct: doDia.length > 0 ? Math.round((feitos / doDia.length) * 100) : 0,
      });
    }
    return linhas;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dia, itens, progresso, secoes]);

  const doDia = itensDoDia(dia);
  const progDia = progressoDoDia(dia);
  const feitosDia = doDia.filter((i) => itemCompleto(i, progDia.get(i.id))).length;
  const semRegistroNenhum = progresso.filter((p) => p.dia === dia).length === 0;

  const carregando = itensQuery.isLoading || progressoQuery.isLoading;

  function copiarRelatorioDoDia() {
    const txt = montarRelatorio({
      itens: doDia, secoes, membros, progresso: progDia,
      dow: diaSemanaDe(dia), dataLabel: dataExtensoDe(dia),
    });
    navigator.clipboard.writeText(txt).then(
      () => toast.success("Relatório copiado"),
      () => toast.error("Não consegui copiar"),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" />
        Visível apenas para administradores
      </div>

      {/* Navegação de data */}
      <Card className="p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-9 w-9 p-0" onClick={() => setDia(somarDias(dia, -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Input
            type="date"
            value={dia}
            max={hojeSP()}
            onChange={(e) => e.target.value && setDia(e.target.value)}
            className="h-9 w-[160px]"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-9 p-0"
            disabled={dia >= hojeSP()}
            onClick={() => setDia(somarDias(dia, 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          {dia !== hojeSP() && (
            <Button variant="ghost" size="sm" className="h-9" onClick={() => setDia(hojeSP())}>
              Hoje
            </Button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-sm font-semibold">{dataExtensoDe(dia)}</div>
            <div className="text-xs text-muted-foreground">
              {doDia.length === 0 ? "nenhum item previsto" : `${feitosDia}/${doDia.length} concluídos`}
            </div>
          </div>
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={copiarRelatorioDoDia}>
            <Copy className="h-3.5 w-3.5" /> Relatório
          </Button>
        </div>
      </Card>

      {carregando ? (
        <Card className="p-8 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando histórico…
        </Card>
      ) : (
        <>
          {/* Últimos 14 dias */}
          <Card className="p-4">
            <h3 className="text-sm font-semibold mb-3">Últimos {DIAS_RESUMO} dias</h3>
            <div className="flex items-end gap-1.5 h-24">
              {serie.map((s) => {
                const vazio = s.total === 0;
                const cor = vazio ? "bg-muted" : s.pct === 100 ? "bg-emerald-500" : s.pct >= 60 ? "bg-amber-500" : "bg-red-500";
                return (
                  <button
                    key={s.dia}
                    onClick={() => setDia(s.dia)}
                    title={`${dataExtensoDe(s.dia)} — ${vazio ? "sem itens previstos" : `${s.feitos}/${s.total}`}`}
                    className="flex-1 flex flex-col items-center gap-1 group"
                  >
                    <div className="w-full flex-1 flex items-end">
                      <div
                        className={cn("w-full rounded-t transition-all group-hover:opacity-80", cor)}
                        style={{ height: `${vazio ? 4 : Math.max(8, s.pct)}%` }}
                      />
                    </div>
                    <span className={cn("text-[9px] tabular-nums", s.dia === dia ? "font-bold" : "text-muted-foreground")}>
                      {s.dia.slice(8)}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* Detalhe do dia */}
          {doDia.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              Nenhum item de rotina previsto para este dia.
            </Card>
          ) : semRegistroNenhum ? (
            <Card className="p-8 text-center">
              <p className="text-sm font-medium">Nenhum registro neste dia.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Os {doDia.length} itens previstos ficaram sem marcação.
              </p>
            </Card>
          ) : (
            membros.map((m) => {
              const meus = doDia.filter((i) => responsavelDe(i, secaoDe.get(i.secao_code)) === m.id);
              if (meus.length === 0) return null;
              const feitos = meus.filter((i) => itemCompleto(i, progDia.get(i.id))).length;
              return (
                <Card key={m.id} className="p-4" style={{ borderLeftWidth: 4, borderLeftColor: m.cor }}>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold" style={{ color: m.cor }}>{m.nome}</h3>
                    <span className={cn("text-sm font-semibold tabular-nums", feitos === meus.length ? "text-emerald-600" : "text-amber-600")}>
                      {feitos}/{meus.length}
                    </span>
                  </div>

                  <div className="flex flex-col gap-2">
                    {meus.map((item) => {
                      const p = progDia.get(item.id);
                      const completo = itemCompleto(item, p);
                      const pendenteDetalhe = faltaDetalhe(item, p);
                      return (
                        <div
                          key={item.id}
                          className={cn(
                            "rounded-lg border p-2.5 text-sm",
                            completo && "bg-emerald-500/5 border-emerald-500/30",
                            pendenteDetalhe && "bg-amber-500/5 border-amber-500/40",
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <span className="mt-0.5 shrink-0 font-mono text-xs">
                              {completo ? "✓" : pendenteDetalhe ? "!" : "·"}
                            </span>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span>{item.texto}</span>
                                <Badge variant="outline" className="text-[10px] py-0">
                                  {item.turno === "inicio" ? "matinal" : "encerramento"}
                                </Badge>
                                {!item.ativo && (
                                  <Badge variant="secondary" className="text-[10px] py-0">item removido depois</Badge>
                                )}
                              </div>

                              {item.tipo === "pergunta" && (
                                <div className="mt-1 text-xs">
                                  <span className="text-muted-foreground">Resposta: </span>
                                  <span className="font-semibold">
                                    {p?.resposta ? p.resposta.toUpperCase() : "sem resposta"}
                                  </span>
                                  {exigeDetalhe(item, p?.resposta) && (
                                    <div className="mt-1 pl-2 border-l-2 border-amber-500/40">
                                      <span className="text-muted-foreground">{item.campo_label ?? "Descreva"}: </span>
                                      {p?.detalhe?.trim() ? (
                                        <span>{p.detalhe}</span>
                                      ) : (
                                        <span className="text-amber-700 dark:text-amber-400 font-semibold">
                                          não preenchido
                                        </span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              {p?.em && (completo || p.resposta) && (
                                <p className="text-[11px] text-muted-foreground mt-1">
                                  {membros.find((x) => x.id === p.por)?.nome ?? "—"} · {horaCurtaSP(p.em)}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
