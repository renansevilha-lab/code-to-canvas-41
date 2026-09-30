// Faixa "Solução do reembolso · Status da solicitação · Status da entrega ·
// Status da devolução"
// das devoluções Shopee (regras em src/lib/shopeeDevolucao.ts).
import {
  solucaoReembolso, statusDevolucaoProduto, statusEntrega, statusSolicitacao, type InfoDevolucao, type Rotulo,
} from "@/lib/shopeeDevolucao";

function Campo({ titulo, r }: { titulo: string; r: Rotulo }) {
  return (
    <div className="min-w-[150px] max-w-[260px]">
      <div className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{titulo}</div>
      <div className="text-[12.5px] font-semibold leading-snug" style={{ color: r.cor }}>{r.rotulo}</div>
      {r.detalhe && <div className="text-[11px] text-muted-foreground leading-snug">{r.detalhe}</div>}
    </div>
  );
}

/** Faixa com Solução · Status da solicitação · Status da entrega (· Devolução do produto). */
export function InfoDevolucaoCampos({ info, carregando }: { info: InfoDevolucao | undefined; carregando?: boolean }) {
  if (!info) {
    return carregando
      ? <div className="text-[11px] text-muted-foreground">carregando status da devolução…</div>
      : null;
  }
  const dev = statusDevolucaoProduto(info);
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 rounded-md bg-muted/40 px-2.5 py-1.5">
      <Campo titulo="Solução do reembolso" r={solucaoReembolso(info)} />
      <Campo titulo="Status da solicitação" r={statusSolicitacao(info)} />
      <Campo titulo="Status da entrega" r={statusEntrega(info)} />
      {dev && <Campo titulo="Status da devolução" r={dev} />}
    </div>
  );
}
