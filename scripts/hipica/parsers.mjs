// Leitura das páginas públicas do sistema de torneios da FPH.
// Os leitores trabalham sobre o texto visível e os links da página, sem depender
// de classes CSS, pra continuar funcionando se o visual do site mudar.
import { load } from 'cheerio/slim';

const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const limpar = s => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const semLinks = l => limpar(l.replace(/⟦[^⟧]*⟧/g, ' '));
const mes = s => MESES[(s || '').toLowerCase().slice(0, 3)];

const RE_MODALIDADE = /^(SALTO|ADESTRAMENTO|CCE|ENDURO|VOLTEIO|PARAEQUESTRE|R[ÉE]DEAS|ATRELAGEM|LONGEUR|CURSOS?|EQUITA)/i;
const RE_STATUS = /(conclu[ií]d|cancelad|andamento|inscri[çc]|encerrad|adiad|aberto|em breve|previsto|realiza)/i;
const RE_PERIODO = /^(\d{1,2})(?:\s*\/\s*([a-zç]{3}))?(?:\s*a\s*(\d{1,2})\s*\/\s*([a-zç]{3}))?$/i;
const RE_PERIODO_SOLTO = /(\d{1,2})\s*\/\s*([a-zç]{3})(?![a-zç\/])(?:\s*a\s*(\d{1,2})\s*\/\s*([a-zç]{3})(?![a-zç\/]))?/i;
const RE_ELIM = /(eliminad[oa]s?|desistente|abandon\w*|desclassificad[oa]|retirad[oa]|n[ãa]o\s+compareceu|ausente)/i;

// Transforma o HTML em linhas de texto, marcando links como ⟦url⟧
export function linhas(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>/gi, (_, q, h) => ` ⟦${h}⟧ `);
  s = s.replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
       .replace(/<\/(?:p|div|li|h[1-6]|tr|td|th|section|article|header|footer|ul|ol|table)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = load(`<x>${s.replace(/</g, '&lt;')}</x>`)('x').text();
  return s.split('\n').map(limpar).filter(Boolean);
}

export function idsDoCalendario(html) {
  return [...new Set([...html.matchAll(/ListaProvas(?:\.aspx)?\?ID=(\d+)/gi)].map(m => +m[1]))];
}

function lerAltura(txt) {
  const m = txt.match(/(\d)[,.](\d{2})\s*M\b/i);
  return m ? +(`${m[1]}.${m[2]}`) : null;
}


// Nome do torneio: primeiro pela meta og:title (seja "property" ou "name"),
// depois pelo título que aparece logo acima da modalidade na página.
export function nomeDoTorneio($, ls) {
  let og = '';
  $('meta').each((_, el) => {
    const k = ($(el).attr('property') || $(el).attr('name') || '').toLowerCase();
    if (!og && k === 'og:title') og = limpar($(el).attr('content'));
  });
  const m = og.match(/^(?:[A-Z]{2,10}\s*-\s*)?(.+?)\s*-\s*LISTA\s+DE\s+PROVAS\s*$/i);
  if (m && m[1] && !/^lista de provas$/i.test(m[1])) return limpar(m[1]);
  // reserva: linha anterior à primeira linha de modalidade
  for (let i = 1; i < ls.length; i++) {
    const t = semLinks(ls[i]);
    if (/^(SALTO|ADESTRAMENTO|CCE|ENDURO|VOLTEIO|PARAEQUESTRE|R[ÉE]DEAS|ATRELAGEM|LONGEUR)\b/i.test(t) && t.length < 60) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const n = semLinks(ls[j]);
        if (n && n.length > 3 && !/^(lista de provas|home|calend|resultados|loading)/i.test(n) && !/^(SALTO|ADESTRAMENTO)\b/i.test(n)) return n;
      }
    }
  }
  return null;
}

// Página "Lista de Provas" de um torneio
export function parseTorneio(html, id) {
  const $ = load(html);
  const ls = linhas(html);
  const nome = nomeDoTorneio($, ls);
  if (!nome) return null;

  // Cabeçalho: modalidade, período, local e situação logo abaixo do nome
  let modalidade = '', status = '', local = '', periodo = null;
  const i0 = ls.findIndex(l => semLinks(l).toUpperCase() === nome.toUpperCase());
  if (i0 >= 0) {
    for (let i = i0 + 1; i < Math.min(ls.length, i0 + 12); i++) {
      let t = semLinks(ls[i]);
      if (!t) continue;
      // o período pode vir colado a outro texto na mesma linha ("SALTO 30/ jul a 02/ ago")
      const pe = t.match(RE_PERIODO_SOLTO);
      if (pe) { if (!periodo) periodo = pe; t = limpar(t.replace(pe[0], ' ')); if (!t) continue; }
      if (!modalidade && RE_MODALIDADE.test(t)) { modalidade = t; continue; }
      const p = t.match(RE_PERIODO);
      if (!periodo && p) { periodo = p; continue; }
      if (!status && RE_STATUS.test(t) && t.length < 40) { status = t; continue; }
      if (/^(Link Copiado!?|Compartilhar|Loading\.*|Carregando|Opções do torneio)$/i.test(t)) continue;
      if (periodo && !local && t.toUpperCase() !== nome.toUpperCase() && t.length < 80) local = t;
      if (modalidade && periodo && local && status) break;
    }
  }

  // Provas, agrupadas pelo dia em que aparecem
  const provas = [];
  const vistos = new Set();
  let dia = null, atual = null, horaSolta = null;
  const fechar = () => {
    if (atual && !vistos.has(atual.numero)) { vistos.add(atual.numero); provas.push(atual); }
    atual = null;
  };
  for (const l of ls) {
    const t = semLinks(l);
    const dh = t.match(/(\d{1,2})\s*\/\s*([a-zç]{3})\s*\/\s*(\d{4})/i);
    if (dh && mes(dh[2])) dia = iso(+dh[3], mes(dh[2]), +dh[1]);
    const soHora = t.match(/^(\d{1,2})\s*[:h]\s*(\d{2})h?$/);
    if (soHora) horaSolta = `${soHora[1].padStart(2, '0')}:${soHora[2]}`;
    const todas = [...t.matchAll(/PR\.?\s*(\d+[A-Z]?)\s*-\s*/gi)];
    if (todas.length) {
      fechar();
      const ult = todas[todas.length - 1];                 // "A seguir da prova X PR. Y": vale a última
      const desc = t.slice(ult.index + ult[0].length).replace(/\s*\/\s*$/, '');
      const partes = desc.split(/\s*-\s+|\s+-\s*/).map(limpar).filter(Boolean);
      const nomeProva = partes.find(x => !/^\d[,.]\d{2}\s*M$/i.test(x) && !x.includes('/') && x.replace(/[^A-ZÀ-Ú]/gi, '').length > 4) || partes[0] || '';
      const antes = t.slice(0, ult.index);
      const hm = antes.match(/(\d{1,2})\s*[:h]\s*(\d{2})/);
      const herdada = horaSolta; horaSolta = null;
      atual = {
        id: null, numero: ult[1].toUpperCase(), nome: nomeProva, desc,
        altura: lerAltura(desc), dia,
        hora: hm ? `${hm[1].padStart(2, '0')}:${hm[2]}` : (/^a seguir/i.test(t) ? 'A seguir' : herdada),
        pista: null, gp: /GRANDE\s+PR[ÊE]MIO|\bGP\b/i.test(desc), linkResultado: false,
      };
    } else if (atual && /^Pista\b/i.test(t)) {
      atual.pista = t.replace(/^Pista\s*(de)?\s*/i, '');
    }
    if (atual) {
      for (const [, href] of l.matchAll(/⟦([^⟧]*)⟧/g)) {
        const r = href.match(/(OrdemEntrada|Resultados)(?:\.aspx)?\?ID=(\d+)/i);
        if (!r) continue;
        atual.id = atual.id || +r[2];
        if (/^Resultados$/i.test(r[1])) atual.linkResultado = true;
      }
    }
  }
  fechar();

  // Período: cabeçalho primeiro, dias das provas como reserva
  const dias = provas.map(p => p.dia).filter(Boolean).sort();
  const anoNome = (nome.match(/\b(20\d{2})\b/) || [])[1];
  const ano = dias.length ? +dias[0].slice(0, 4) : (anoNome ? +anoNome : new Date().getFullYear());
  let inicio = dias[0] || null, fim = dias[dias.length - 1] || null;
  if (periodo) {
    const d1 = +periodo[1], m1 = mes(periodo[2]);
    const d2 = periodo[3] ? +periodo[3] : d1, m2 = mes(periodo[4]) || m1;
    if (m1) {
      inicio = iso(ano, m1, d1);
      fim = iso(m2 < m1 ? ano + 1 : ano, m2, d2);
    }
  }

  return { id, nome, modalidade, local, status, inicio, fim, provas };
}

// Página "Resultados" de uma prova
export function parseResultados(html) {
  const $ = load(html);
  const linhasTabela = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length < 4) return;
    const pos = limpar($(tds[0]).text()).match(/^(\d+)\s*[ºo°]/);
    if (!pos) return;

    const partes = el => ($(el).html() || '')
      .split(/<br\s*\/?>|<\/(?:div|p|strong|b)>/i)
      .map(x => limpar(load(`<x>${x}</x>`)('x').text()))
      .filter(Boolean);

    const pCav = partes(tds[1]);
    const cavaleiro = limpar($(tds[1]).find('strong,b').first().text()) || pCav[0] || '';
    const resto = pCav.filter(p => p.toUpperCase() !== cavaleiro.toUpperCase());
    const federacao = resto.find(p => /FEDERA|CONFEDERA|ASSOCIA|CLUBE|LIGA|SOCIEDADE/i.test(p)) || '';
    const cavalo = limpar($(tds[2]).find('strong,b').first().text()) || partes(tds[2])[0] || '';

    const textos = tds.toArray().slice(4).map(td => limpar($(td).text()));
    const st = textos.map(t => t.match(RE_ELIM)).find(Boolean);
    const status = st ? st[1][0].toUpperCase() + st[1].slice(1).toLowerCase() : null;

    // Pares faltas/tempo na ordem em que aparecem (percurso, desempate...)
    const fases = [];
    let f = null;
    for (const t of textos) {
      const re = /(\d+(?:,\d+)?)\s*\(\s*[\d,]+\s*\+\s*[\d,]+\s*\)|(\d{1,3},\d{2})/g;
      let x;
      while ((x = re.exec(t))) {
        if (x[1] !== undefined) { f = [num(x[1]), null]; fases.push(f); }
        else if (f && f[1] === null) f[1] = num(x[2]);
      }
    }
    if (!fases.length && !status) {
      const fi = textos.find(t => /^\d+(,\d+)?$/.test(t));
      const ti = textos.map(t => t.match(/\b(\d{1,3},\d{2})\b/)).find(Boolean);
      if (fi) fases.push([num(fi), ti ? num(ti[1]) : null]);
    }
    const unicas = fases.filter((x, i) => i === 0 || x[0] !== fases[i - 1][0] || x[1] !== fases[i - 1][1]);

    linhasTabela.push({ pos: +pos[1], cavaleiro, federacao, cavalo, status, fases: status ? [] : unicas });
  });
  return linhasTabela;
}

function num(s) { return +String(s).replace(',', '.'); }

// Página "Ordem de Entrada" de uma prova: quem está inscrito, na ordem em que entra na pista
export function parseOrdemEntrada(html) {
  const $ = load(html);
  const linhas = [];
  $('tr').each((_, tr) => {
    const tds = $(tr).children('td');
    if (tds.length < 4) return;
    const ordem = limpar($(tds[0]).text()).match(/^(\d+)/);
    if (!ordem) return;
    const cavaleiro = limpar($(tds[1]).find('strong,b').first().text()) || limpar($(tds[1]).text());
    const cavalo = limpar($(tds[2]).find('strong,b').first().text());
    const categoria = limpar($(tds[3]).find('strong,b').first().text()).replace(/\s*-\s*$/, '');
    if (!cavaleiro || !cavalo) return;
    linhas.push({ o: +ordem[1], c: cavaleiro, h: cavalo, cat: categoria || null });
  });
  return linhas;
}
