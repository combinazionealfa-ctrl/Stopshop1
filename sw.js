/**
 * Service worker di StopShop.
 *  - tiene l'app disponibile offline;
 *  - conserva le attese in corso nella Cache API, così sopravvivono allo
 *    spegnimento del worker (il localStorage da qui non si vede);
 *  - mostra il promemoria a scadenza e apre l'attesa al tocco.
 */
const VERSIONE = 'stopshop-v1'
const CACHE_ATTESE = 'stopshop-attese'
const CHIAVE = 'attese.json'
const RISORSE = ['./', './index.html', './manifest.webmanifest', './favicon.svg', './icona-192.png', './icona-512.png', './icona-maskable-512.png']
const timer = new Map()

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSIONE).then((c) => c.addAll(RISORSE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((chiavi) => Promise.all(chiavi.filter((k) => k !== VERSIONE && k !== CACHE_ATTESE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return

  // Navigazioni: sempre l'app, anche senza rete.
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then((r) => r || fetch(req)))
    return
  }
  // Font: prima la cache, poi la rete che la aggiorna.
  if (/fonts\.(googleapis|gstatic)\.com/.test(req.url)) {
    e.respondWith(
      caches.open(VERSIONE).then((c) =>
        c.match(req).then((r) => {
          const rete = fetch(req).then((risposta) => { c.put(req, risposta.clone()); return risposta }).catch(() => r)
          return r || rete
        }),
      ),
    )
    return
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req).catch(() => r)))
})

/* ---------- attese ----------------------------------------------------- */
async function leggiAttese() {
  const c = await caches.open(CACHE_ATTESE)
  const r = await c.match(CHIAVE)
  return r ? r.json() : []
}
async function scriviAttese(lista) {
  const c = await caches.open(CACHE_ATTESE)
  await c.put(CHIAVE, new Response(JSON.stringify(lista), { headers: { 'content-type': 'application/json' } }))
}
/**
 * Subito dopo l'avvio del worker la registrazione può non essere ancora
 * "attiva": showNotification in quel momento fallisce. Si aspetta il tempo
 * necessario invece di perdere il promemoria.
 */
async function pronta() {
  for (let i = 0; i < 30 && !self.registration.active; i++) {
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function mostra(a) {
  await pronta()
  return self.registration.showNotification(a.titolo, {
    body: a.corpo,
    tag: 'attesa-' + a.id,
    icon: './icona-192.png',
    badge: './icona-192.png',
    data: { url: a.url },
  })
}
function programma(a) {
  const ritardo = a.quando - Date.now()
  if (ritardo <= 0) return
  if (timer.has(a.id)) clearTimeout(timer.get(a.id))
  timer.set(a.id, setTimeout(async () => {
    timer.delete(a.id)
    await mostra(a)
    const lista = await leggiAttese()
    await scriviAttese(lista.filter((x) => x.id !== a.id))
  }, ritardo))
}
async function controllaScadute() {
  const lista = await leggiAttese()
  const adesso = Date.now()
  const scadute = lista.filter((a) => a.quando <= adesso)
  const consegnate = []
  for (const a of scadute) {
    try {
      await mostra(a)
      consegnate.push(a.id)
    } catch (e) {
      // Se la consegna fallisce l'attesa resta in elenco e si riprova dopo.
    }
  }
  const restano = lista.filter((a) => a.quando > adesso || consegnate.indexOf(a.id) < 0)
  if (consegnate.length) await scriviAttese(restano)
  restano.filter((a) => a.quando > adesso).forEach(programma)
}

self.addEventListener('message', (event) => {
  const d = event.data || {}
  if (d.tipo === 'programma-attesa') {
    event.waitUntil(leggiAttese().then((lista) => {
      programma(d.attesa)
      return scriviAttese(lista.filter((a) => a.id !== d.attesa.id).concat([d.attesa]))
    }))
  }
  if (d.tipo === 'sincronizza-attese') {
    event.waitUntil(scriviAttese(d.attese || []).then(() => (d.attese || []).forEach(programma)))
  }
  if (d.tipo === 'annulla-attesa') {
    if (timer.has(d.id)) { clearTimeout(timer.get(d.id)); timer.delete(d.id) }
    event.waitUntil(leggiAttese().then((lista) => scriviAttese(lista.filter((a) => a.id !== d.id))))
  }
  if (d.tipo === 'controlla-attese') event.waitUntil(controllaScadute())
})

// Recupero all'avvio del worker, fuori dalla fase di attivazione.
self.addEventListener('activate', () => { setTimeout(() => controllaScadute(), 500) })

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'controllo-attese') e.waitUntil(controllaScadute())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || './'
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((finestre) => {
      for (const f of finestre) {
        if ('focus' in f && 'navigate' in f) return f.focus().then((c) => c.navigate(url))
      }
      return self.clients.openWindow(url)
    }),
  )
})
