import { Clock } from "lucide-react";

// Sub-abas Amazon / TikTok de /promocoes enquanto a integração não existe:
// mostra o que a API permite e o que falta (estudo de 07/out/2026).

export function PromocoesEmBreve({ marketplace }: { marketplace: "amazon" | "tiktok" }) {
  const nome = marketplace === "amazon" ? "Amazon" : "TikTok Shop";
  return (
    <div className="rounded-xl border border-dashed p-8 flex flex-col items-center gap-3 text-center">
      <div className="h-10 w-10 rounded-[10px] grid place-items-center bg-muted text-muted-foreground">
        <Clock className="h-5 w-5" />
      </div>
      <div className="text-[15px] font-semibold">Promoções da {nome} — em estudo</div>
      <p className="text-[13px] text-muted-foreground max-w-[56ch]">
        Esta sub-aba vai reunir as promoções e campanhas da {nome}, com a margem de contribuição de cada produto,
        como já acontece na Shopee e no Mercado Livre.
      </p>
    </div>
  );
}
