// Leitura de XML fiscal (NF-e, evento de NF-e, CT-e) — sem dependência. Usado pela edge function `fiscal-nfe`
// e pelo script `fechamento/scripts/parse_nfe.mjs` (o Node 24 importa este .ts direto). Só sintaxe que some
// ao tirar os tipos: nada de enum, namespace ou parâmetro com modificador.

// ---------- XML mínimo: árvore {tag: valor | objeto | lista}; prefixo de namespace e atributos (menos Id) fora ----------
const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const txt = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

export function lerXml(xml: string): any {
  const raiz: any = {}; const pilha: any[] = [{ no: raiz, nome: "" }];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([^\s>]+)\s*>|<([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  const por = (pai: any, nome: string, valor: any) => {
    if (pai.no[nome] === undefined) pai.no[nome] = valor;
    else if (Array.isArray(pai.no[nome])) pai.no[nome].push(valor);
    else pai.no[nome] = [pai.no[nome], valor];
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const topo = pilha[pilha.length - 1];
    if (m[1] != null) { topo.texto = (topo.texto ?? "") + m[1]; continue; }
    if (m[2] != null) {
      if (pilha.length < 2) continue;
      const f = pilha.pop(); const pai = pilha[pilha.length - 1];
      por(pai, f.nome, Object.keys(f.no).length === 0 ? txt(String(f.texto ?? "").trim()) : f.no);
      continue;
    }
    if (m[3] != null) {
      const nome = m[3].includes(":") ? m[3].split(":").pop()! : m[3];
      const no: any = {}; const id = /\bId="([^"]*)"/.exec(m[4] ?? ""); if (id) no["@Id"] = id[1];
      if (m[5] === "/") por(topo, nome, Object.keys(no).length ? no : "");
      else pilha.push({ no, nome });
      continue;
    }
    if (m[6] != null && m[6].trim()) topo.texto = (topo.texto ?? "") + m[6];
  }
  return raiz;
}

export const lista = (x: any): any[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n: number) => Math.round(n * 100) / 100;
/** primeiro grupo filho de um nó de imposto (ex.: ICMS → ICMS00 | ICMS40 | ICMSSN102…) */
const grupo = (no: any): any => { if (!no || typeof no !== "object") return {}; const k = Object.keys(no).find((x) => typeof no[x] === "object"); return k ? no[k] : {}; };

/** NF-e (nfeProc ou NFe solta) → cabeçalho + itens; null se o documento não é NF-e. */
export function notaDe(doc: any, arquivo = ""): any {
  const nfe = doc.nfeProc?.NFe ?? doc.NFe; const inf = nfe?.infNFe;
  if (!inf) return null;
  const ide = inf.ide ?? {}, emit = inf.emit ?? {}, dest = inf.dest ?? {}, tot = inf.total?.ICMSTot ?? {};
  const prot = doc.nfeProc?.protNFe?.infProt ?? {};
  const cfops: Record<string, number> = {};
  const itens = lista(inf.det).map((d, i) => {
    const p = d.prod ?? {}, imp = d.imposto ?? {};
    const icms = grupo(imp.ICMS), pis = grupo(imp.PIS), cof = grupo(imp.COFINS), uf = imp.ICMSUFDest ?? {};
    cfops[p.CFOP] = r2((cfops[p.CFOP] ?? 0) + num(p.vProd));
    return {
      n: i + 1, cProd: p.cProd ?? "", xProd: p.xProd ?? "", NCM: p.NCM ?? "", CFOP: p.CFOP ?? "", uCom: p.uCom ?? "", qCom: num(p.qCom),
      vProd: num(p.vProd), vDesc: num(p.vDesc), vFrete: num(p.vFrete), vOutro: num(p.vOutro),
      orig: icms.orig ?? "", cstICMS: icms.CST ?? icms.CSOSN ?? "", pICMS: num(icms.pICMS), vBC: num(icms.vBC), vICMS: num(icms.vICMS), vST: num(icms.vICMSST),
      vICMSUFDest: num(uf.vICMSUFDest), vFCPUFDest: num(uf.vFCPUFDest),
      cstPIS: pis.CST ?? "", vPIS: num(pis.vPIS), cstCOFINS: cof.CST ?? "", vCOFINS: num(cof.vCOFINS),
      vIPI: num(grupo(imp.IPI).vIPI),
    };
  });
  return {
    chave: String(inf["@Id"] ?? "").replace(/^NFe/, "") || prot.chNFe || "", numero: ide.nNF ?? "", serie: ide.serie ?? "",
    data: ide.dhEmi ?? ide.dEmi ?? "", tpNF: ide.tpNF ?? "", finNFe: ide.finNFe ?? "", natOp: ide.natOp ?? "",
    emit_cnpj: emit.CNPJ ?? emit.CPF ?? "", emit_nome: emit.xNome ?? "", emit_uf: emit.enderEmit?.UF ?? "",
    dest_doc: dest.CNPJ ?? dest.CPF ?? dest.idEstrangeiro ?? "", dest_nome: dest.xNome ?? "", dest_uf: dest.enderDest?.UF ?? "", indIEDest: dest.indIEDest ?? "",
    vProd: num(tot.vProd), vFrete: num(tot.vFrete), vDesc: num(tot.vDesc), vOutro: num(tot.vOutro), vICMS: num(tot.vICMS), vST: num(tot.vST),
    vIPI: num(tot.vIPI), vPIS: num(tot.vPIS), vCOFINS: num(tot.vCOFINS), vICMSUFDest: num(tot.vICMSUFDest), vFCPUFDest: num(tot.vFCPUFDest),
    vNF: num(tot.vNF), cStat: prot.cStat ?? "", refNFe: lista(ide.NFref).map((r) => r.refNFe).filter(Boolean),
    cfops, itens, arquivo,
  };
}

/** Eventos de NF-e (cancelamento = tpEvento 110111, carta de correção = 110110…). */
export function eventosDe(doc: any, arquivo = ""): any[] {
  const procs = [...lista(doc.procEventoNFe), ...(doc.envEvento?.evento ? [{ evento: doc.envEvento.evento }] : []), ...(doc.evento ? [{ evento: doc.evento, retEvento: doc.retEvento }] : [])];
  const out: any[] = [];
  for (const e of procs) for (const ev of lista(e.evento)) {
    const i = ev.infEvento; if (!i) continue;
    out.push({ chave: i.chNFe ?? "", tpEvento: i.tpEvento ?? "", desc: i.detEvento?.descEvento ?? "", data: i.dhEvento ?? "", cStat: e.retEvento?.infEvento?.cStat ?? "", arquivo });
  }
  return out;
}

export function cteDe(doc: any, arquivo = ""): any {
  const cte = doc.cteProc?.CTe ?? doc.CTe; const inf = cte?.infCte; if (!inf) return null;
  const ide = inf.ide ?? {}, emit = inf.emit ?? {}, icms = grupo(inf.imp?.ICMS);
  const toma = inf.ide?.toma3?.toma ?? inf.ide?.toma4?.toma ?? "";
  return {
    chave: String(inf["@Id"] ?? "").replace(/^CTe/, ""), numero: ide.nCT ?? "", serie: ide.serie ?? "", data: ide.dhEmi ?? "", CFOP: ide.CFOP ?? "", natOp: ide.natOp ?? "",
    emit_cnpj: emit.CNPJ ?? "", emit_nome: emit.xNome ?? "", toma, rem_doc: inf.rem?.CNPJ ?? inf.rem?.CPF ?? "", dest_doc: inf.dest?.CNPJ ?? inf.dest?.CPF ?? "",
    vTPrest: num(inf.vPrest?.vTPrest), cstICMS: icms.CST ?? "", pICMS: num(icms.pICMS), vICMS: num(icms.vICMS), cStat: doc.cteProc?.protCTe?.infProt?.cStat ?? "", arquivo,
  };
}
