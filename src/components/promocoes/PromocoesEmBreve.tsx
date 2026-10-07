import { CheckCircle2, Clock, XCircle } from "lucide-react";

// Sub-abas Amazon / TikTok de /promocoes enquanto a integração não existe:
// o que a API permite, o que já temos e o que depende do dono.
// Estudo completo em docs/promocoes-amazon-tiktok.md (07/out/2026).

type Linha = { ok: boolean | null; texto: string };

const CONTEUDO: Record<"amazon" | "tiktok", { nome: string; resumo: string; linhas: Linha[]; falta: string[] }> = {
  amazon: {
    nome: "Amazon",
    resumo:
      "A Amazon não deixa criar Ofertas Relâmpago, Cupons ou desconto Prime pela API — isso continua no Seller Central. " +
      "Pela API dá para LER essas promoções (Promotions API, de ago/2026) e criar PREÇO PROMOCIONAL com data de início e fim, anúncio a anúncio.",
    linhas: [
      { ok: true, texto: "Ler Ofertas, Cupons e descontos ativos, com a margem de contribuição de cada produto" },
      { ok: true, texto: "Criar/encerrar preço promocional com agenda (como a Minha Promoção da Shopee), com prévia e confirmação" },
      { ok: true, texto: "Taxas reais da Amazon no cálculo da margem (hoje é estimativa de 12% + FBA por faixa)" },
      { ok: false, texto: "Criar Oferta Relâmpago, Cupom ou desconto Prime — só no Seller Central" },
      { ok: null, texto: "Campanhas de anúncio (Sponsored Products): a conexão está pronta, mas nenhuma conta foi conectada ainda (teste de 07/out: 0 contas)" },
    ],
    falta: [
      "Teste de 07/out: leitura de promoções e de preço LIBERADA nas duas contas (ACZ tem descontos, ofertas e cupons ativos; SVL nenhum)",
      "Para criar preço promocional: o \"Token de comerciante\" (Merchant Token, começa com A…) de cada conta — Seller Central › Configurações › Informações da conta",
      "Para os ADS: criar o app da Amazon Ads API e conectar ACZ e SVL",
    ],
  },
  tiktok: {
    nome: "TikTok Shop",
    resumo:
      "O TikTok permite pela API quase tudo o que fazemos no Mercado Livre: criar, editar e encerrar promoções " +
      "(desconto %, preço fixo e relâmpago) e colocar ou tirar produtos. A loja ACZ já autorizou essas permissões.",
    linhas: [
      { ok: true, texto: "Listar as promoções da loja e os produtos em cada uma, com a margem de contribuição" },
      { ok: true, texto: "Criar desconto ou preço fixo, adicionar/remover produtos e encerrar — com prévia e confirmação" },
      { ok: null, texto: "Um produto fica em uma promoção por vez: entrar numa tira da anterior (a tela avisa)" },
      { ok: false, texto: "Criar cupom e inscrever em campanhas da plataforma — sem API confirmada" },
      { ok: false, texto: "Loja Bumi: ainda não autorizou o app" },
    ],
    falta: ["Autorizar o app na loja Bumi (se quiser as duas)", "Aprovar a criação da integração (nova função + tela)"],
  },
};

export function PromocoesEmBreve({ marketplace }: { marketplace: "amazon" | "tiktok" }) {
  const c = CONTEUDO[marketplace];
  return (
    <div className="rounded-xl border p-5 md:p-6 flex flex-col gap-4 max-w-3xl">
      <div className="flex items-center gap-2.5">
        <div className="h-9 w-9 rounded-[10px] grid place-items-center bg-muted text-muted-foreground">
          <Clock className="h-4.5 w-4.5" />
        </div>
        <div>
          <div className="text-[15px] font-semibold">Promoções da {c.nome} — ainda não integradas</div>
          <div className="text-[12.5px] text-muted-foreground">O que a API permite, pelo estudo de 07/out/2026</div>
        </div>
      </div>
      <p className="text-[13.5px] leading-relaxed">{c.resumo}</p>
      <ul className="flex flex-col gap-2">
        {c.linhas.map((l, i) => (
          <li key={i} className="flex items-start gap-2 text-[13px]">
            {l.ok === true ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-600" />
              : l.ok === false ? <XCircle className="h-4 w-4 shrink-0 mt-0.5 text-red-500" />
              : <Clock className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />}
            <span>{l.texto}</span>
          </li>
        ))}
      </ul>
      <div className="rounded-lg bg-muted/50 px-4 py-3">
        <div className="text-[12px] font-semibold text-muted-foreground mb-1.5">Para começar, falta</div>
        <ul className="list-disc pl-5 text-[13px] flex flex-col gap-1">
          {c.falta.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      </div>
    </div>
  );
}
