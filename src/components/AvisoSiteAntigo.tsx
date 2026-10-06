import { useEffect, useState } from "react";

// ============================================================================
// Aviso GIGANTE no site antigo (Lovable). O app mudou para a Cloudflare em
// 29/set/2026 e parte da equipe continua no endereço do Lovable. O mesmo
// código roda nos dois lugares: o aviso só aparece quando o endereço é do
// Lovable (lovable.app / lovableproject.com). No site novo não renderiza nada.
// Decisão no client (useEffect) para não quebrar a hidratação do SSR.
// ============================================================================

const SITE_NOVO = "https://ottz-pet-app.ottzpet.workers.dev";

function ehSiteAntigo(host: string): boolean {
  return /(^|\.)lovable\.app$/i.test(host) || /(^|\.)lovableproject\.com$/i.test(host);
}

export function AvisoSiteAntigo() {
  const [destino, setDestino] = useState<string | null>(null);

  useEffect(() => {
    if (!ehSiteAntigo(window.location.hostname)) return;
    setDestino(`${SITE_NOVO}${window.location.pathname}${window.location.search}${window.location.hash}`);
  }, []);

  if (!destino) return null;

  return (
    <>
      {/* faixa fixa no topo de TODAS as telas, inclusive o login */}
      <div
        role="alert"
        className="fixed inset-x-0 top-0 z-[9999] bg-red-600 text-white shadow-2xl border-b-4 border-yellow-300"
      >
        <div className="mx-auto max-w-6xl px-4 py-4 sm:py-5 flex flex-col sm:flex-row items-center gap-3 sm:gap-6 text-center sm:text-left">
          <div className="flex-1">
            <div className="text-2xl sm:text-4xl font-black uppercase tracking-tight leading-tight">
              ⚠ Este site é o ANTIGO
            </div>
            <div className="text-base sm:text-lg font-semibold mt-1">
              Use o site novo: <span className="underline break-all">ottz-pet-app.ottzpet.workers.dev</span>
              {" "}— entre com o seu login e escolha a impressora de novo.
            </div>
          </div>
          <a
            href={destino}
            className="shrink-0 rounded-xl bg-yellow-300 text-red-800 px-6 py-3 text-lg sm:text-xl font-black uppercase shadow-lg hover:bg-yellow-200 focus:outline-none focus:ring-4 focus:ring-white"
          >
            Ir para o site novo →
          </a>
        </div>
      </div>
      {/* empurra o conteúdo para baixo da faixa */}
      <div aria-hidden className="h-[176px] sm:h-[120px]" />
    </>
  );
}
