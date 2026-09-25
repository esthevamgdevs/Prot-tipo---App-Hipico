// Salta · envio de notificações
// Roda no fim de cada coleta: compara o que mudou nesta rodada com o que cada inscrito
// acompanha e envia os avisos por web push. As inscrições ficam no Supabase do Salta.
//
// Segredos esperados (GitHub Actions): SUPABASE_URL, SUPABASE_SECRET_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Sem eles, o envio é pulado.
import fs from 'node:fs/promises';
import path from 'node:path';
import webpush from 'web-push';
import { CAT_INFANTIL, abreviar } from './estatisticas.mjs';

const MAX_POR_PESSOA = 4;          // avisos por pessoa em cada rodada
const JANELA_DEDUP_DIAS = 30;       // quanto tempo lembramos do que já foi enviado

const chave = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const PEQ = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'ao', 'a', 'o', 'du', 'van', 'von', 'del', 'la', 'le']);
const titulo = s => String(s || '').toLowerCase().split(/\s+/).map((w, i) =>
  (i > 0 && PEQ.has(w)) ? w : w.replace(/(^|[^a-zà-ÿ])([a-zà-ÿ])/g, (_, a, b) => a + b.toUpperCase())).join(' ');
const alt = h => h == null ? '' : h.toFixed(2).replace('.', ',') + 'm';
const numProva = p => String(p.numero || '').replace(/^0+(?=\d)/, '');

export async function enviarAvisos({ saida, anterior, atual }) {
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    console.log('Avisos: segredos não configurados, envio pulado.');
    return { enviados: 0 };
  }
  const base = SUPABASE_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const H = { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' };
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  // 1) O que é novidade nesta rodada
  const antes = new Map((anterior?.torneios || []).map(t => [t.id, t]));
  const novosResultados = [];
  const programacoes = [];
  for (const t of atual) {
    const a = antes.get(t.id);
    for (const p of t.provas) {
      const tinha = a && a.provas.find(x => x.id === p.id)?.res;
      if (p.res && p.id && !tinha) novosResultados.push({ t, p });
    }
    // só avisa programação de torneio que já conhecíamos sem provas (evita avisar tudo na primeira coleta)
    if (a && !a.provas.length && t.provas.length) programacoes.push(t);
  }
  if (!novosResultados.length && !programacoes.length) {
    console.log('Avisos: nenhuma novidade nesta rodada.');
    return { enviados: 0 };
  }

  // 2) Quem está inscrito
  const ri = await fetch(`${base}/rest/v1/inscricoes?select=endpoint,p256dh,auth,seguindo,torneios,avisos`, { headers: H });
  if (!ri.ok) { console.warn(`Avisos: não deu para ler as inscrições (HTTP ${ri.status}).`); return { enviados: 0 }; }
  const inscricoes = await ri.json();
  if (!inscricoes.length) { console.log('Avisos: ninguém inscrito ainda.'); return { enviados: 0 }; }

  // 3) Pódios das provas novas
  const cacheTorneio = new Map();
  const lerTorneio = async id => {
    if (!cacheTorneio.has(id)) {
      try { cacheTorneio.set(id, JSON.parse(await fs.readFile(path.join(saida, 't', `${id}.json`), 'utf8'))); }
      catch { cacheTorneio.set(id, null); }
    }
    return cacheTorneio.get(id);
  };
  const podios = [];
  for (const { t, p } of novosResultados) {
    const dados = await lerTorneio(t.id);
    const infantil = CAT_INFANTIL.test(`${p.nome || ''} ${p.desc || ''}`);
    for (const l of dados?.provas?.[String(p.id)] || []) {
      if (l.p > 3 || l.s) continue;
      podios.push({ t, p, l, ck: chave(l.c), hk: chave(l.h), infantil });
    }
  }

  // 4) O que já foi enviado recentemente, para não repetir
  const desde = new Date(Date.now() - JANELA_DEDUP_DIAS * 864e5).toISOString();
  const re = await fetch(`${base}/rest/v1/enviados?select=endpoint,chave&enviado_em=gte.${encodeURIComponent(desde)}`, { headers: H });
  const jaEnviados = new Set(re.ok ? (await re.json()).map(x => `${x.endpoint} ${x.chave}`) : []);

  // 5) Montar e enviar
  let enviados = 0, expirados = 0, falhas = 0;
  const registrar = [];
  for (const i of inscricoes) {
    const segue = new Set((i.seguindo || []).map(s => `${s.tipo}:${s.k}`));
    const salvos = new Set((i.torneios || []).map(Number));
    const prefs = i.avisos || {};
    const msgs = [];

    if (prefs.podio !== false) {
      for (const pd of podios) {
        const pelaPessoa = segue.has(`cavaleiros:${pd.ck}`), peloCavalo = segue.has(`cavalos:${pd.hk}`);
        if (!pelaPessoa && !peloCavalo) continue;
        const nome = pd.infantil ? abreviar(pd.l.c) : titulo(pd.l.c);
        msgs.push({
          chave: `res:${pd.p.id}:${pelaPessoa ? pd.ck : pd.hk}`,
          titulo: pd.l.p === 1 ? 'Vitória de quem você segue' : 'Pódio de quem você segue',
          texto: `${nome} ficou em ${pd.l.p}º na Prova ${numProva(pd.p)} · ${alt(pd.p.altura)} com ${titulo(pd.l.h)} (${titulo(pd.t.nome)})`,
          url: `./#t=${pd.t.id}&p=${pd.p.id}`,
          tag: `prova-${pd.p.id}`,
        });
      }
    }
    if (prefs.programa !== false) {
      for (const t of programacoes) {
        if (!salvos.has(t.id)) continue;
        msgs.push({
          chave: `prog:${t.id}`,
          titulo: 'Programação publicada',
          texto: `${titulo(t.nome)} publicou ${t.provas.length} provas.`,
          url: `./#t=${t.id}`,
          tag: `torneio-${t.id}`,
        });
      }
    }

    const pendentes = msgs.filter(m => !jaEnviados.has(`${i.endpoint} ${m.chave}`));
    if (!pendentes.length) continue;
    // muitos de uma vez viram um resumo, para não encher a tela de ninguém
    let fila = pendentes;
    if (pendentes.length > MAX_POR_PESSOA) {
      fila = pendentes.slice(0, MAX_POR_PESSOA - 1);
      fila.push({ chave: null, titulo: 'Mais novidades no Salta', texto: `E mais ${pendentes.length - fila.length} resultados de quem você segue.`, url: './', tag: 'resumo' });
    }

    const assinatura = { endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } };
    let expirou = false;
    for (const m of fila) {
      try {
        await webpush.sendNotification(assinatura, JSON.stringify({ titulo: m.titulo, texto: m.texto, url: m.url, tag: m.tag }), { TTL: 60 * 60 * 24 });
        enviados++;
        if (m.chave) registrar.push({ endpoint: i.endpoint, chave: m.chave });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { expirou = true; break; }
        falhas++;
      }
    }
    // o resumo conta como "visto" para os que ficaram de fora dele
    if (!expirou && pendentes.length > fila.length) {
      for (const m of pendentes.slice(fila.length - 1)) if (m.chave) registrar.push({ endpoint: i.endpoint, chave: m.chave });
    }
    if (expirou) {
      expirados++;
      await fetch(`${base}/rest/v1/inscricoes?endpoint=eq.${encodeURIComponent(i.endpoint)}`, { method: 'DELETE', headers: H }).catch(() => {});
    }
  }

  if (registrar.length) {
    await fetch(`${base}/rest/v1/enviados?on_conflict=endpoint,chave`, {
      method: 'POST',
      headers: { ...H, Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(registrar),
    }).catch(() => {});
  }
  console.log(`Avisos: ${enviados} enviados, ${expirados} inscrições expiradas removidas, ${falhas} falhas.`);
  return { enviados, expirados, falhas };
}
