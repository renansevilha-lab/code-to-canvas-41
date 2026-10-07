import { Hand, Tag, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LOJAS } from "./comum";
import { MinhaPromocao } from "./MinhaPromocao";
import { Relampago } from "./Relampago";
import { RelampagoManual } from "./RelampagoManual";

// ============================================================================
// Promoções Shopee — sub-aba de /promocoes (antes a rota /promocoes-shopee):
//   · Minha Promoção: descontos da loja (v2.discount) com CMV/MC/desconto;
//   · Relâmpago: programação diária da Promoção Relâmpago;
//   · Relâmpago manual: lista/cria flash sale direto (antiga /promocoes).
// Aba e loja ficam na URL (sobrevivem à remontagem).
// ============================================================================

export type AbaShopee = "minha" | "relampago" | "manual";

export function PromocoesShopee({ aba, loja, onChange }: {
  aba: AbaShopee; loja: number; onChange: (patch: { aba?: AbaShopee; loja?: number }) => void;
}) {
  return (
    <Tabs value={aba} onValueChange={(v) => onChange({ aba: v as AbaShopee })}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList>
          <TabsTrigger value="minha" className="gap-1.5"><Tag className="h-3.5 w-3.5" /> Minha Promoção</TabsTrigger>
          <TabsTrigger value="relampago" className="gap-1.5"><Zap className="h-3.5 w-3.5" /> Relâmpago</TabsTrigger>
          <TabsTrigger value="manual" className="gap-1.5"><Hand className="h-3.5 w-3.5" /> Relâmpago manual</TabsTrigger>
        </TabsList>
        <div className="flex items-center gap-2">
          {LOJAS.map((l) => (
            <Button key={l.shop_id} size="sm" variant={loja === l.shop_id ? "default" : "outline"}
              className="h-8" onClick={() => onChange({ loja: l.shop_id })}>
              {l.nome}
            </Button>
          ))}
        </div>
      </div>
      <TabsContent value="minha" className="mt-4">
        <MinhaPromocao key={loja} shopId={loja} />
      </TabsContent>
      <TabsContent value="relampago" className="mt-4">
        <Relampago key={loja} shopId={loja} />
      </TabsContent>
      <TabsContent value="manual" className="mt-4">
        <RelampagoManual shop={loja} />
      </TabsContent>
    </Tabs>
  );
}
