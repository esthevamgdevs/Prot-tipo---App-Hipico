// Salta · service worker
// Só cuida das notificações. Não guarda páginas em cache, então o app nunca fica preso numa versão velha.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', evento => evento.waitUntil(self.clients.claim()));

self.addEventListener('push', evento => {
  let dados = {};
  try { dados = evento.data ? evento.data.json() : {}; }
  catch { dados = { titulo: 'Salta', texto: evento.data ? evento.data.text() : '' }; }
  evento.waitUntil(self.registration.showNotification(dados.titulo || 'Salta', {
    body: dados.texto || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: dados.tag || undefined,
    data: { url: dados.url || './' },
  }));
});

self.addEventListener('notificationclick', evento => {
  evento.notification.close();
  const destino = new URL((evento.notification.data && evento.notification.data.url) || './', self.registration.scope).href;
  evento.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const janela of janelas) {
      if ('focus' in janela) {
        try { await janela.navigate(destino); } catch {}
        return janela.focus();
      }
    }
    return self.clients.openWindow(destino);
  })());
});
