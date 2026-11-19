// Pedidos Integrados › "Preço e promoção" (12/nov/2026, pedido do dono): abre, a partir do pedido, o editor de
// promoção dos SKUs dele e deixa mudar ali mesmo o preço da promoção em andamento.
// Shopee = o MESMO editor da aba "Preço e promoção" do anúncio (PrecoPromocao): Minha Promoção (preço promocional
// editável na Shopee, com a MC) e a relâmpago diária (preço da programação).
// Mercado Livre (18/nov/2026, pedido do dono) = PrecoPromoML: os anúncios do SKU, as promoções em que estão e o
// desconto editável nas campanhas em que o ML deixa escolher (conta Ottz; a SVL não tem as promoções no app).
// Amazon e TikTok abrem a tela de Promoções deles.
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PrecoPromocao } from "@/components/ia/anuncio/PrecoPromocao";
import { PrecoPromoML } from "@/components/pedidos/PrecoPromoML";

interface PedidoBase { order_sn: string; marketplace: string | null; empresa: string | null; canal: string | null; skus: string | null }

const MKT_PROMO: Record<string, "ml" | "amazon" | "tiktok"> = { mercadolivre: "ml", mercado_livre: "ml", amazon: "amazon", tiktok: "tiktok" };

export function EditorPrecoPromo({ pedido }: { pedido: PedidoBase }) {
  const [aberto, setAberto] = useState(false);
  const skus = useMemo(() => [...new Set((pedido.skus ?? "").split(",").map((x) => x.trim()).filter(Boolean))], [pedido.skus]);
  const [sku, setSku] = useState<string | null>(null);
  const [outraLoja, setOutraLoja] = useState(false);
  const mkt = (pedido.marketplace ?? "").toLowerCase();
  const shopee = mkt === "shopee" || /shopee/i.test(pedido.canal ?? "");
  const empresa = /svl|sevilla|bumi/i.test(`${pedido.empresa ?? ""} ${pedido.canal ?? ""}`) ? "svl" : "ottz";
  const ml = !shopee && (MKT_PROMO[mkt] === "ml" || /mercado\s*livre/i.test(pedido.canal ?? "")) && empresa === "ottz";
  const atual = sku ?? skus[0] ?? null;
  if (!skus.length) return null;

  return (
    <>
      <Button size="sm" variant="outline" className="h-8 gap-1.5 self-start" onClick={(e) => { e.stopPropagation(); setAberto(true); }}>
        <Tag className="h-3.5 w-3.5" />Preço e promoção
      </Button>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-w-5xl max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Preço e promoção · {pedido.canal ?? pedido.marketplace}</DialogTitle>
          </DialogHeader>
          {shopee ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {skus.length > 1 && skus.map((s) => (
                  <Button key={s} size="sm" variant={s === atual ? "default" : "outline"} className="h-7 font-mono text-xs" onClick={() => setSku(s)}>{s}</Button>
                ))}
                <div className="flex-1" />
                <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={outraLoja} onChange={(e) => setOutraLoja(e.target.checked)} />
                  Mostrar também a outra loja
                </label>
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                O preço da Minha Promoção muda na Shopee na hora (com confirmação). A relâmpago diária vale a partir da próxima que o app criar.
                O preço cheio do anúncio não muda por aqui.
              </p>
              {atual && <PrecoPromocao key={`${atual}-${outraLoja}`} sku={atual} empresa={empresa} soDaEmpresa={!outraLoja} semRodape focoNoSku />}
            </div>
          ) : ml ? (
            <div className="space-y-3">
              {skus.length > 1 && (
                <div className="flex flex-wrap items-center gap-2">
                  {skus.map((s) => (
                    <Button key={s} size="sm" variant={s === atual ? "default" : "outline"} className="h-7 font-mono text-xs" onClick={() => setSku(s)}>{s}</Button>
                  ))}
                </div>
              )}
              <p className="text-[11.5px] text-muted-foreground">
                Nas campanhas em que o Mercado Livre deixa escolher, o desconto muda na hora (com confirmação e a margem recalculada). Nas promoções de preço fixo do
                Mercado Livre só dá para entrar ou sair. O preço cheio do anúncio não muda por aqui.
              </p>
              {atual && <PrecoPromoML key={atual} sku={atual} />}
            </div>
          ) : (
            <div className="space-y-3 text-sm">
              <p>O editor por pedido cobre a Shopee e o Mercado Livre (conta Ottz). As promoções deste canal ficam na tela de Promoções.</p>
              <Button asChild size="sm" variant="outline">
                <Link to="/promocoes" search={{ mkt: MKT_PROMO[mkt] ?? "ml" } as never} target="_blank">
                  Abrir Promoções <ExternalLink className="h-3.5 w-3.5 ml-1" />
                </Link>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
