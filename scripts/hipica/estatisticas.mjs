// Estatísticas do Pista: ranking da temporada e perfis de cavaleiros e cavalos,
// calculados a partir dos resultados já coletados (nada é buscado na FPH aqui).
//
// Privacidade: em provas de categorias infantis o sobrenome do atleta é abreviado,
// como fazem outros apps de hipismo, porque essas provas são disputadas por crianças.
import fs from 'node:fs/promises';
import path from 'node:path';

// Códigos de categoria da FPH que correspondem a crianças (mini mirim, pré-mirim, mirim...)
export const CAT_INFANTIL = /\b(MMR|PMR|MRA|MRB|MIRIM|PR[ÉE][- ]?MIRIM|MINI[- ]?MIRIM|INFANTIL|KIDS?)\b/i;
const SIGLAS = [
  [/PAULISTA/i, 'FPH'], [/PARANAENSE/i, 'FPrH'], [/BRAS[ÍI]LIA/i, 'FHBr'],
  [/RIO DE JANEIRO/i, 'FEERJ'], [/MINAS/i, 'FHMG'], [/RIO GRANDE DO SUL|GA[ÚU]CHA/i, 'FGH'],
  [/SANTA CATARINA|CATARINENSE/i, 'FCH'], [/GOI[ÁA]S|GOIANA/i, 'FHGO'], [/BAHIA|BAIANA/i, 'FBH'],
  [/PERNAMBUC/i, 'FPeH'], [/CEAR[ÁA]/i, 'FCeH'], [/MATO GROSSO DO SUL/i, 'FHMS'],
  [/MATO GROSSO/i, 'FHMT'], [/ESP[ÍI]RITO SANTO/i, 'FHES'], [/CONFEDERA/i, 'CBH'],
];
const sigla = f => { for (const [re, s] of SIGLAS) if (re.test(f || '')) return s; return null; };

// "MARIA EDUARDA PARMA RODRIGUES" -> "Maria Eduarda P. R." em provas infantis
export function abreviar(nome) {
  const partes = nome.trim().split(/\s+/);
  if (partes.length <= 2) return partes.map(p => p[0] + p.slice(1).toLowerCase()).join(' ');
  return partes.slice(0, 2).map(p => p[0] + p.slice(1).toLowerCase()).join(' ') + ' ' +
    partes.slice(2).map(p => p[0] + '.').join(' ');
}

const chave = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

export async function gerarEstatisticas(saida, torneios, anoDe) {
  const cavaleiros = new Map(), cavalos = new Map(), clubes = new Map();
  const novo = (nome) => ({ nome, largadas: 0, vitorias: 0, podios: 0, zerados: 0, parceiros: new Map(), hist: [], fed: null, infantil: 0 });
  const pega = (mapa, nome) => { const k = chave(nome); if (!mapa.has(k)) mapa.set(k, novo(nome)); return mapa.get(k); };

  for (const t of torneios) {
    if (!t.fim || t.fim < anoDe) continue;
    let dados;
    try { dados = JSON.parse(await fs.readFile(path.join(saida, 't', `${t.id}.json`), 'utf8')); } catch { continue; }
    const provas = new Map(t.provas.map(p => [String(p.id), p]));
    for (const [pid, linhas] of Object.entries(dados.provas || {})) {
      const p = provas.get(pid) || {};
      const infantil = CAT_INFANTIL.test(`${p.nome || ''} ${p.desc || ''}`);
      const total = linhas.length;
      for (const l of linhas) {
        const zerou = !l.s && l.r && l.r[0] && l.r[0][0] === 0;
        const fed = l.f != null ? dados.fed[l.f] : null;
        const item = { d: p.dia || t.fim, t: t.nome, ti: t.id, pn: p.numero, a: p.altura, p: l.p, n: total, r: l.r || null, s: l.s || null };

        const c = pega(cavaleiros, l.cavaleiro || l.c);
        c.largadas++; if (l.p === 1) c.vitorias++; if (l.p <= 3) c.podios++; if (zerou) c.zerados++;
        if (infantil) c.infantil++;
        if (fed && !c.fed) c.fed = fed;
        c.parceiros.set(l.h, (c.parceiros.get(l.h) || 0) + 1);
        c.hist.push({ ...item, h: l.h });

        const h = pega(cavalos, l.h);
        h.largadas++; if (l.p === 1) h.vitorias++; if (l.p <= 3) h.podios++; if (zerou) h.zerados++;
        if (infantil) h.infantil++;
        h.parceiros.set(l.c, (h.parceiros.get(l.c) || 0) + 1);
        h.hist.push({ ...item, c: l.c });

        if (fed) {
          if (!clubes.has(fed)) clubes.set(fed, { nome: fed, largadas: 0, vitorias: 0, podios: 0 });
          const cl = clubes.get(fed);
          cl.largadas++; if (l.p === 1) cl.vitorias++; if (l.p <= 3) cl.podios++;
        }
      }
    }
  }

  // Nome exibido: abreviado quando a maioria das largadas foi em prova infantil
  const arruma = (x, tipoPessoa) => {
    const proteger = tipoPessoa && x.infantil > x.largadas / 2;
    const nome = proteger ? abreviar(x.nome) : x.nome;
    const hist = x.hist.sort((a, b) => (b.d || '').localeCompare(a.d || '')).slice(0, 8);
    const parceiros = [...x.parceiros.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, q]) => ({ n, q }));
    const porAltura = {};
    for (const it of x.hist) {
      if (it.a == null) continue;
      const k = it.a.toFixed(2);
      porAltura[k] = porAltura[k] || [0, 0];
      porAltura[k][0]++; if (it.p === 1) porAltura[k][1]++;
    }
    return {
      nome, prot: proteger || undefined, fed: x.fed ? (sigla(x.fed) || x.fed) : undefined,
      l: x.largadas, v: x.vitorias, po: x.podios, z: x.zerados,
      alt: porAltura, par: parceiros, hist,
    };
  };

  // Perfis divididos por letra inicial: o app baixa só o pedaço que precisa
  const fatia = k => { const c = k[0]; return /[A-Z]/.test(c) ? c : (/[0-9]/.test(c) ? '0' : '_'); };
  const perfis = { cavaleiros: {}, cavalos: {} };
  const busca = [];
  for (const [tipo, mapa, pessoa] of [['cavaleiros', cavaleiros, true], ['cavalos', cavalos, false]]) {
    for (const [k, x] of mapa) {
      const perfil = arruma(x, pessoa);
      const f = fatia(k);
      (perfis[tipo][f] = perfis[tipo][f] || {})[k] = perfil;
      busca.push([tipo === 'cavaleiros' ? 'c' : 'h', k, perfil.nome, perfil.l, perfil.v]);
    }
  }
  const dirPerfis = path.join(saida, 'perfis');
  await fs.rm(dirPerfis, { recursive: true, force: true });
  for (const [tipo, fatias] of Object.entries(perfis)) {
    for (const [f, conteudo] of Object.entries(fatias)) {
      const arq = path.join(dirPerfis, tipo, `${f}.json`);
      await fs.mkdir(path.dirname(arq), { recursive: true });
      await fs.writeFile(arq, JSON.stringify(conteudo) + '\n');
    }
  }
  busca.sort((a, b) => b[3] - a[3]);
  await fs.writeFile(path.join(saida, 'busca.json'), JSON.stringify(busca) + '\n');

  const topo = (mapa, tipoPessoa) => [...mapa.entries()]
    .map(([k, x]) => ({ k, ...arruma(x, tipoPessoa) }))
    .filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v || b.po - a.po || b.z - a.z)
    .slice(0, 50)
    .map(({ k, nome, fed, l, v, po, z }) => ({ k, nome, fed, l, v, po, z }));

  const stats = {
    atualizadoEm: new Date().toISOString(),
    desde: anoDe,
    totais: {
      torneios: torneios.filter(t => t.fim >= anoDe && t.provas.some(p => p.res)).length,
      cavaleiros: cavaleiros.size, cavalos: cavalos.size,
      percursos: [...cavaleiros.values()].reduce((s, x) => s + x.largadas, 0),
    },
    cavaleiros: topo(cavaleiros, true),
    cavalos: topo(cavalos, false),
    clubes: [...clubes.values()].map(c => ({ ...c, nome: sigla(c.nome) ? c.nome : c.nome, sig: sigla(c.nome) }))
      .sort((a, b) => b.vitorias - a.vitorias).slice(0, 20),
  };

  await fs.writeFile(path.join(saida, 'stats.json'), JSON.stringify(stats) + '\n');
  return stats.totais;
}
