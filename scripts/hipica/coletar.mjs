// Coletor do Pista: calendário e resultados públicos de SALTO do sistema da FPH.
// Roda no GitHub Actions e grava em data/hipica/ (lido pelo hipica.html).
//
// Boas práticas com o site da federação:
//  - respeita o robots.txt (para tudo se o acesso for proibido)
//  - uma página por vez, com pausa entre elas, e um teto de páginas por execução
//  - resultados já coletados não são baixados de novo depois que o torneio fecha
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTorneio, parseResultados, parseOrdemEntrada, idsDoCalendario } from './parsers.mjs';
import { gerarEstatisticas, CAT_INFANTIL, abreviar } from './estatisticas.mjs';
import { enviarAvisos } from './avisos.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SAIDA = path.resolve(DIR, process.env.SAIDA || '../../data/hipica');
const BASE = (process.env.BASE_URL || 'https://www.fph.com.br').replace(/\/$/, '');
const INTERVALO_MS = +(process.env.INTERVALO_MS ?? 1500);  // pausa entre páginas
const MAX_PAGINAS = +(process.env.MAX_PAGINAS ?? 700);     // teto por execução
const ID_INICIAL = +(process.env.ID_INICIAL ?? 3300);      // primeiro torneio a considerar
const JANELA_NOVOS = +(process.env.JANELA_NOVOS ?? 25);    // quantos IDs acima do maior conhecido sondar
const A_PARTIR = process.env.A_PARTIR || '2026-01-01';     // ignora torneios que terminaram antes disto
const DESDE = process.env.DESDE || A_PARTIR;               // resultados a partir desta data
const UA = 'SaltaApp/0.2 (app de hipismo; +https://github.com/esthevamgdevs/Prototipo-Hipismo)';

const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
// Coleta completa (descobre torneios novos) quatro vezes por dia; nas outras horas, só os torneios em andamento.
const MODO = process.env.MODO || ([12, 17, 21, 0].includes(new Date().getUTCHours()) ? 'completo' : 'rapido'); // 9h, 14h, 18h e 21h em Brasília
const MIN_ENTRE_REVISOES = 50 * 60e3; // uma prova de hoje ou de ontem é revista no máximo a cada ~50 min
const somarDias = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dormir = ms => new Promise(r => setTimeout(r, ms));

const AMOSTRAS = +(process.env.AMOSTRAS ?? 3);   // páginas não reconhecidas guardadas pra diagnóstico
let amostras = 0, naoReconhecidos = 0;
async function guardarAmostra(nome, html) {
  const arq = path.join(SAIDA, '_diagnostico', nome);
  await fs.mkdir(path.dirname(arq), { recursive: true });
  await fs.writeFile(arq, html.slice(0, 400000));
  console.log(`  ? página não reconhecida guardada em data/hipica/_diagnostico/${nome}`);
}

// Decide se o resultado de uma prova precisa ser baixado de novo nesta execução
function precisaRever(p, ultima, refazerAte) {
  if (!ultima) return true;                              // nunca lido
  if (ultima === 'vazio') return false;                  // prova que nunca teve resultado publicado
  if (ultima.slice(0, 10) > refazerAte) return false;    // já passou a janela de correções
  const recente = p.dia && p.dia >= somarDias(hoje, -1); // prova de hoje ou de ontem
  if (recente) {
    const quando = Date.parse(ultima.length > 10 ? ultima : ultima + 'T12:00:00Z');
    return Date.now() - quando > MIN_ENTRE_REVISOES;
  }
  return ultima.slice(0, 10) < hoje;                     // provas mais antigas: uma revisão por dia
}

class LimiteAtingido extends Error {}
let paginas = 0;

const MAX_MINUTOS = +(process.env.MAX_MINUTOS ?? 30);        // para e salva antes do limite do Actions
const inicioExecucao = Date.now();

async function baixar(caminho) {
  if (paginas >= MAX_PAGINAS) throw new LimiteAtingido();
  if (Date.now() - inicioExecucao > MAX_MINUTOS * 60000) throw new LimiteAtingido();
  paginas++;
  if (paginas > 1) await dormir(INTERVALO_MS);
  const url = BASE + caminho;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      });
      // A FPH responde 500 para torneios/provas que não existem: não insistimos.
      if (r.status === 404 || r.status === 500) return null;
      // Só vale tentar de novo quando o servidor pede calma ou está instável
      if ([429, 502, 503, 504].includes(r.status)) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) { console.warn(`  ! ${caminho}: HTTP ${r.status}`); return null; }
      return await r.text();
    } catch (e) {
      if (tentativa === 3) { console.warn(`  ! falhou ${caminho}: ${e.message}`); return null; }
      await dormir(8000 * tentativa);
    }
  }
}

async function robotsPermite() {
  try {
    const r = await fetch(BASE + '/robots.txt', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return true;
    const bloqueios = [];
    let grupoGeral = false;
    for (const bruta of (await r.text()).split(/\r?\n/)) {
      const l = bruta.replace(/#.*/, '').trim();
      const [k, ...v] = l.split(':');
      const valor = v.join(':').trim();
      if (/^user-agent$/i.test(k)) grupoGeral = valor === '*' || /salta|pista/i.test(valor);
      else if (grupoGeral && /^disallow$/i.test(k) && valor) bloqueios.push(valor);
    }
    const caminhos = ['/calendario/ListaProvas.aspx', '/calendario/Resultados.aspx', '/calendario/Default'];
    return !caminhos.some(c => bloqueios.some(b => c.toLowerCase().startsWith(b.toLowerCase())));
  } catch { return true; }
}

async function lerJSON(arquivo, padrao) {
  try { return JSON.parse(await fs.readFile(arquivo, 'utf8')); } catch { return padrao; }
}
async function gravarJSON(arquivo, dados, identar = 0) {
  await fs.mkdir(path.dirname(arquivo), { recursive: true });
  await fs.writeFile(arquivo, JSON.stringify(dados, null, identar) + '\n');
}

async function main() {
  console.log(`Salta · coleta FPH · ${hoje} · modo ${MODO}`);
  if (!(await robotsPermite())) {
    console.error('O robots.txt da FPH não permite acesso a estas páginas. Nada foi coletado.');
    process.exit(1);
  }

  const arqIndice = path.join(SAIDA, 'index.json');
  const arqEstado = path.join(SAIDA, 'estado.json');
  const indice = await lerJSON(arqIndice, { torneios: [] });
  const anterior = JSON.parse(JSON.stringify(indice)); // foto de antes, para saber o que é novidade nos avisos
  const estado = await lerJSON(arqEstado, { maiorId: 0, ignorados: [], resultados: {} });
  const ignorados = new Set(estado.ignorados);
  const torneios = new Map(indice.torneios.map(t => [t.id, t]));
  const arquivosTorneio = new Map();
  let limite = false;
  let cal = null;

  try {
    // 1) Descobrir torneios
    const candidatos = new Set();
    if (MODO === 'completo') {
      // calendário do mês + IDs novos + torneios ainda abertos
      cal = await baixar('/calendario/Default');
      const doCalendario = cal ? idsDoCalendario(cal) : [];
      doCalendario.forEach(id => candidatos.add(id));
      const topo = Math.max(estado.maiorId || ID_INICIAL - 1, ...doCalendario, 0);
      for (let id = (estado.maiorId ? estado.maiorId + 1 : ID_INICIAL); id <= topo + JANELA_NOVOS; id++) candidatos.add(id);
      for (const t of torneios.values()) {
        const aberto = !/conclu|cancel/i.test(t.status || '');
        if (aberto || (t.fim && t.fim >= somarDias(hoje, -3))) candidatos.add(t.id);
      }
    } else {
      // só o que está acontecendo ou começa nos próximos dias (programação e resultados)
      for (const t of torneios.values()) {
        if (/cancel/i.test(t.status || '')) continue;
        if (t.inicio && t.fim && t.inicio <= somarDias(hoje, 3) && t.fim >= somarDias(hoje, -2)) candidatos.add(t.id);
      }
    }

    const lista = [...candidatos].filter(id => !ignorados.has(id)).sort((a, b) => a - b);
    console.log(`Verificando ${lista.length} torneios…`);
    let n = 0;
    for (const id of lista) {
      if (++n % 20 === 0) console.log(`  … ${n}/${lista.length} verificados`);
      const html = await baixar(`/calendario/ListaProvas.aspx?ID=${id}`);
      if (!html) continue;
      const t = parseTorneio(html, id);
      if (!t) {
        naoReconhecidos++;
        if (amostras < AMOSTRAS && html.length > 3000) { amostras++; await guardarAmostra(`torneio-${id}.html`, html); }
        continue;
      }
      estado.maiorId = Math.max(estado.maiorId || 0, id);
      if (!/^SALTO/i.test(t.modalidade)) { ignorados.add(id); torneios.delete(id); continue; }
      if (t.fim && t.fim < A_PARTIR) { ignorados.add(id); torneios.delete(id); continue; } // temporadas anteriores
      const antes = torneios.get(id);
      // mantém o que já sabíamos sobre resultados de cada prova
      if (antes) for (const p of t.provas) {
        const velha = antes.provas.find(x => x.id === p.id);
        if (velha) { p.res = velha.res; p.v = velha.v; if (velha.oe) p.oe = velha.oe; }
      }
      t.url = `${BASE}/calendario/ListaProvas.aspx?ID=${id}`;
      torneios.set(id, t);
      console.log(`  ✓ ${id} ${t.nome} (${t.provas.length} provas)`);
    }

    // 2) Resultados das provas de torneios que já começaram
    const comResultado = [...torneios.values()]
      .filter(t => t.fim && t.fim >= DESDE && t.inicio <= hoje && !/cancel/i.test(t.status || ''))
      .sort((a, b) => (b.fim || '').localeCompare(a.fim || ''));
    for (const t of comResultado) {
      const arq = path.join(SAIDA, 't', `${t.id}.json`);
      const dados = arquivosTorneio.get(t.id) || await lerJSON(arq, { id: t.id, fed: [], provas: {} });
      arquivosTorneio.set(t.id, dados);
      const refazerAte = somarDias(t.fim, 2); // correções costumam sair em até 2 dias
      for (const p of t.provas) {
        if (!p.id || (p.dia && p.dia > hoje)) continue;
        if (!precisaRever(p, estado.resultados[p.id], refazerAte)) continue;
        const html = await baixar(`/calendario/Resultados.aspx?ID=${p.id}`);
        if (!html) continue;
        const linhas = parseResultados(html);
        if (linhas.length) {
          dados.provas[p.id] = linhas.map(l => {
            let f = -1;
            if (l.federacao) { f = dados.fed.indexOf(l.federacao); if (f < 0) { dados.fed.push(l.federacao); f = dados.fed.length - 1; } }
            const linha = { p: l.pos, c: l.cavaleiro, h: l.cavalo };
            if (f >= 0) linha.f = f;
            if (l.status) linha.s = l.status;
            if (l.fases.length) linha.r = l.fases;
            return linha;
          });
          p.res = true;
          p.v = { c: linhas[0].cavaleiro, h: linhas[0].cavalo };
          estado.resultados[p.id] = new Date().toISOString();
        } else if (hoje > somarDias(t.fim, 7)) {
          estado.resultados[p.id] = 'vazio'; // prova sem resultado publicado (ex.: cancelada)
        }
      }
      console.log(`  ✓ resultados ${t.id} ${t.nome}`);
    }

    // 3) Ordem de entrada: provas de hoje e dos próximos dois dias que ainda não têm resultado
    const ateDia = somarDias(hoje, 2);
    estado.ordem = estado.ordem || {};
    const comOrdem = [...torneios.values()].filter(t => !/cancel/i.test(t.status || '') &&
      t.provas.some(p => p.id && !p.res && p.dia && p.dia >= hoje && p.dia <= ateDia));
    for (const t of comOrdem) {
      const arq = path.join(SAIDA, 't', `${t.id}.json`);
      const dados = arquivosTorneio.get(t.id) || await lerJSON(arq, { id: t.id, fed: [], provas: {} });
      dados.ordem = dados.ordem || {};
      arquivosTorneio.set(t.id, dados);
      for (const p of t.provas) {
        if (!p.id || p.res || !p.dia || p.dia < hoje || p.dia > ateDia) continue;
        const ultima = estado.ordem[p.id];
        const intervalo = p.dia === hoje ? MIN_ENTRE_REVISOES : 3 * 3600e3; // no dia, de hora em hora; antes, a cada 3 h
        if (ultima && Date.now() - Date.parse(ultima) < intervalo) continue;
        const html = await baixar(`/calendario/OrdemEntrada.aspx?ID=${p.id}`);
        if (!html) continue;
        estado.ordem[p.id] = new Date().toISOString();
        const linhas = parseOrdemEntrada(html);
        const provaInfantil = CAT_INFANTIL.test(`${p.nome || ''} ${p.desc || ''}`);
        dados.ordem[p.id] = linhas.map(l => {
          const protegido = provaInfantil || CAT_INFANTIL.test(l.cat || '');
          const linha = { o: l.o, c: protegido ? abreviar(l.c) : l.c, h: l.h };
          if (l.cat) linha.cat = l.cat;
          return linha;
        });
        p.oe = linhas.length;
      }
      console.log(`  ✓ ordem de entrada ${t.id} ${t.nome}`);
    }
  } catch (e) {
    if (e instanceof LimiteAtingido) {
      limite = true;
      console.log(`Teto de páginas ou de tempo atingido; o restante fica pra próxima execução.`);
    } else throw e;
  }

  // 3) Gravar
  for (const [id, dados] of arquivosTorneio) {
    if (Object.keys(dados.provas).length || Object.keys(dados.ordem || {}).length) await gravarJSON(path.join(SAIDA, 't', `${id}.json`), dados);
  }
  const listaTorneios = [...torneios.values()].filter(t => !t.fim || t.fim >= A_PARTIR).sort((a, b) => (a.inicio || '').localeCompare(b.inicio || ''));
  const mudou = JSON.stringify(listaTorneios) !== JSON.stringify(indice.torneios);
  await gravarJSON(arqIndice, {
    fonte: 'Federação Paulista de Hipismo (fph.com.br)',
    atualizadoEm: mudou || !indice.atualizadoEm ? new Date().toISOString() : indice.atualizadoEm,
    torneios: listaTorneios,
  }, 1);
  estado.ignorados = [...ignorados].sort((a, b) => a - b);
  await gravarJSON(arqEstado, estado, 1);

  // 4) Ranking e perfis, calculados sobre o que já está gravado
  const totais = await gerarEstatisticas(SAIDA, listaTorneios, A_PARTIR);
  console.log(`Estatísticas: ${totais.cavaleiros} cavaleiros, ${totais.cavalos} cavalos, ${totais.percursos} percursos.`);

  // 5) Avisos para quem ativou as notificações (uma falha aqui nunca derruba a coleta)
  try { await enviarAvisos({ saida: SAIDA, anterior, atual: listaTorneios }); }
  catch (e) { console.warn('Avisos: falha no envio,', e.message); }
  if (!listaTorneios.length && cal) await guardarAmostra('calendario.html', cal);
  console.log(`Pronto: ${listaTorneios.length} torneios de salto, ${paginas} páginas lidas, ${naoReconhecidos} páginas não reconhecidas${limite ? ' (parcial)' : ''}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
