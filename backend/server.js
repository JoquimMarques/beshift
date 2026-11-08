const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const admin = require('firebase-admin');
const geoip = require('geoip-lite');
const Stripe = require('stripe');
require('dotenv').config();

const app = express();
app.use(cors());
// O webhook do Stripe valida a assinatura sobre o corpo em bruto, por isso
// nao pode passar pelo express.json(). Todas as outras rotas continuam em JSON.
app.use((req, res, next) => {
  // tolerante a barra final e a query string (ex.: /api/stripe/webhook/?x=1)
  if (req.path.replace(/\/+$/, '') === '/api/stripe/webhook') return next();
  return express.json()(req, res, next);
});

// Inicializar o Firebase Admin
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin inicializado com sucesso através das variáveis de ambiente.");
  } else {
    serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

  }
} catch (error) {
  console.warn("⚠️ A inicialização do Firebase Admin falhou.");
  console.warn("Certifique-se de que FIREBASE_SERVICE_ACCOUNT está definido no .env ou que serviceAccountKey.json existe.");
}

const db = admin.firestore ? admin.firestore() : null;

// Middleware de Autenticação (Firebase OU sessão NeuroQR sem conta)
const authenticate = async (req, res, next) => {
  if (!db) return res.status(500).json({ error: 'Banco de dados não inicializado' });

  const sessionId = req.headers['x-session-id']?.trim();
  if (sessionId && sessionId.length >= 8) {
    req.user = { uid: `neuroqr_${sessionId}` };
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autorizado: Nenhum token fornecido' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Não autorizado: Token inválido' });
  }
};

// ---------------------------------------------------------------------------
// Geolocalização e filtragem de bots
// ---------------------------------------------------------------------------

// Bots de pré-visualização (WhatsApp, Facebook, Telegram, etc.) e crawlers.
// Estes pedidos recebem o redirect normalmente, mas não contam como clique.
const BOT_UA_REGEX = /whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|linkedinbot|slackbot|discordbot|skypeuripreview|pinterest|redditbot|applebot|googlebot|bingbot|yandex|duckduckbot|baiduspider|petalbot|embedly|quora link preview|outbrain|vkshare|w3c_validator|snapchat|iframely|curl\/|wget\/|python-requests|go-http-client|headlesschrome|bot\b|crawler|spider|preview/i;

const isBotRequest = (req) => {
  if (req.method === 'HEAD') return true;
  const ua = req.headers['user-agent'];
  if (!ua) return true; // browsers reais enviam sempre User-Agent
  return BOT_UA_REGEX.test(ua);
};

const isPrivateIp = (ip) =>
  /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80)/i.test(ip);

// Cache em memória para não repetir lookups externos (ip-api.com: 45 req/min)
const GEO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEO_CACHE_MAX = 5000;
const geoCache = new Map();

const cacheGet = (ip) => {
  const entry = geoCache.get(ip);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > entry.ttl) { geoCache.delete(ip); return undefined; }
  return entry.code;
};
const cacheSet = (ip, code, ttl = GEO_CACHE_TTL_MS) => {
  if (geoCache.size >= GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value);
  geoCache.set(ip, { code, ts: Date.now(), ttl });
};

// Fallback externo para gamas que a base local do geoip-lite não cobre
// (ex.: blocos AFRINIC recentes como Finstar 102.215.182.x em Angola).
const lookupCountryExternal = async (ip) => {
  if (typeof fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resp = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode`, {
      signal: controller.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data && data.status === 'success' && data.countryCode ? data.countryCode : null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

// Devolve o código ISO-3166 (ex.: 'AO') ou null
const lookupCountryCode = async (ip) => {
  if (!ip || isPrivateIp(ip)) return null;

  const cached = cacheGet(ip);
  if (cached !== undefined) return cached;

  const geo = geoip.lookup(ip);
  if (geo && geo.country) {
    cacheSet(ip, geo.country);
    return geo.country;
  }

  const external = await lookupCountryExternal(ip);
  // Resultado nulo fica em cache por menos tempo para permitir nova tentativa
  cacheSet(ip, external, external ? GEO_CACHE_TTL_MS : 60 * 60 * 1000);
  return external;
};

// Nome do país em português + bandeira, a partir do código ISO (ex.: 'AO' -> 'Angola 🇦🇴')
let regionNames = null;
try { regionNames = new Intl.DisplayNames(['pt'], { type: 'region' }); } catch (e) { regionNames = null; }

const flagEmoji = (code) =>
  code.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65));

const formatCountry = (code) => {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return 'Desconhecido';
  const upper = code.toUpperCase();
  let name = null;
  try { name = regionNames ? regionNames.of(upper) : null; } catch (e) { name = null; }
  if (!name || name === upper) name = upper;
  return `${name} ${flagEmoji(upper)}`;
};

// Endpoint de Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK' });
});

// Endpoint de Redirecionamento
app.get('/:shortId', async (req, res) => {
  if (!db) return res.status(500).send('Banco de dados não inicializado');
  
  const { shortId } = req.params;
  
  // Ignorar rotas de API do check de redirecionamento
  if (shortId === 'api') {
      return res.status(404).send('Não Encontrado');
  }

  try {
    const linkRef = db.collection('links').doc(shortId);
    const doc = await linkRef.get();
    
    if (!doc.exists) {
      // Retorna uma página de 404 em HTML
      return res.status(404).send('<h2>404 - Link Não Encontrado</h2>');
    }

    const linkData = doc.data();

    // Bots de pré-visualização (WhatsApp, Facebook, ...) e pedidos HEAD
    // recebem o redirect mas não contam como clique.
    if (isBotRequest(req)) {
      return res.redirect(linkData.originalUrl);
    }

    // Obter IP e País
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
    if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);

    let country = 'Desconhecido';
    let countryCode = null;

    if (ip === '::1' || ip === '127.0.0.1') {
        country = 'Localhost (Seu PC) 💻';
    } else {
        countryCode = await lookupCountryCode(ip);
        country = formatCountry(countryCode);
    }

    // Salvar visualização
    const viewRef = linkRef.collection('views').doc();
    const viewPromise = viewRef.set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ip: ip || 'Desconhecido',
      country: country,
      countryCode: countryCode,
      userAgent: (req.headers['user-agent'] || '').slice(0, 300)
    });

    // Incrementar cliques (visualizações)
    const updatePromise = linkRef.update({
      clicks: admin.firestore.FieldValue.increment(1)
    });

    await Promise.all([viewPromise, updatePromise]);

    // Redirecionar para a URL original
    res.redirect(linkData.originalUrl);
  } catch (error) {
    console.error("Erro ao redirecionar:", error);
    res.status(500).send('Erro no Servidor');
  }
});

// API: Endpoint para Encurtar URL
app.post('/api/shorten', authenticate, async (req, res) => {
  const { originalUrl, customAlias } = req.body;
  if (!originalUrl) {
    return res.status(400).json({ error: 'A URL original é obrigatória' });
  }

  // Validar URL
  try {
    new URL(originalUrl);
  } catch (_) {
    return res.status(400).json({ error: 'Formato de URL inválido. Por favor, inclua http:// ou https://' });
  }

  // Usar apelido personalizado ou gerar um
  const shortId = customAlias ? customAlias.trim() : nanoid(7);

  try {
    const linkRef = db.collection('links').doc(shortId);
    const doc = await linkRef.get();

    if (doc.exists) {
      return res.status(400).json({ error: 'Este apelido já está em uso. Por favor, tente outro.' });
    }

    const newLink = {
      shortId,
      originalUrl,
      clicks: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      userId: req.user.uid
    };

    await linkRef.set(newLink);

    res.status(201).json(newLink);
  } catch (error) {
    console.error("Erro ao encurtar URL:", error);
    res.status(500).json({ error: 'Erro no Servidor' });
  }
});

// API: Endpoint para Eliminar um Link
app.delete('/api/links/:shortId', authenticate, async (req, res) => {
  try {
    const { shortId } = req.params;
    const linkRef = db.collection('links').doc(shortId);
    const linkDoc = await linkRef.get();

    if (!linkDoc.exists || linkDoc.data().userId !== req.user.uid) {
        return res.status(404).json({ error: 'Link não encontrado ou não autorizado' });
    }

    // Opcional: deletar também a sub-coleção 'views' para poupar espaço
    const viewsSnapshot = await linkRef.collection('views').get();
    const batch = db.batch();
    viewsSnapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    
    // Deletar o próprio link
    batch.delete(linkRef);
    await batch.commit();

    res.json({ message: 'Link eliminado com sucesso' });
  } catch (error) {
    console.error("Erro ao eliminar link:", error);
    res.status(500).json({ error: 'Erro no Servidor ao eliminar' });
  }
});

// API: Alterar o destino de um link (QR dinâmico: o código impresso continua igual)
app.patch('/api/links/:shortId', authenticate, async (req, res) => {
  const { shortId } = req.params;
  const { originalUrl } = req.body || {};

  if (!originalUrl) {
    return res.status(400).json({ error: 'A URL original é obrigatória' });
  }
  try {
    new URL(originalUrl);
  } catch (_) {
    return res.status(400).json({ error: 'Formato de URL inválido. Por favor, inclua http:// ou https://' });
  }

  try {
    const linkRef = db.collection('links').doc(shortId);
    const linkDoc = await linkRef.get();

    if (!linkDoc.exists || linkDoc.data().userId !== req.user.uid) {
      return res.status(404).json({ error: 'Link não encontrado ou não autorizado' });
    }

    await linkRef.update({
      originalUrl,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ shortId, originalUrl, message: 'Destino atualizado com sucesso' });
  } catch (error) {
    console.error("Erro ao atualizar link:", error);
    res.status(500).json({ error: 'Erro no Servidor ao atualizar' });
  }
});

// API: Endpoint para Detalhes de um Link Específico
app.get('/api/stats/:shortId', authenticate, async (req, res) => {
  try {
    const { shortId } = req.params;
    const linkRef = db.collection('links').doc(shortId);
    const linkDoc = await linkRef.get();

    if (!linkDoc.exists || linkDoc.data().userId !== req.user.uid) {
        return res.status(404).json({ error: 'Link não encontrado' });
    }

    const viewsSnapshot = await linkRef.collection('views').get();
    
    const views = [];
    viewsSnapshot.forEach(doc => {
        const data = doc.data();
        views.push({
            country: data.country || 'Desconhecido',
            countryCode: data.countryCode || null,
            timestamp: data.timestamp ? data.timestamp.toDate() : new Date()
        });
    });

    // Ordenar em memória (mais recentes primeiro) para evitar erro de index
    views.sort((a, b) => b.timestamp - a.timestamp);

    res.json({ views });
  } catch (error) {
    console.error("Erro ao buscar detalhes:", error);
    res.status(500).json({ error: 'Erro no Servidor' });
  }
});

// API: Endpoint para Obter Estatísticas
app.get('/api/stats', authenticate, async (req, res) => {
  try {
    const linksSnapshot = await db.collection('links')
                                  .where('userId', '==', req.user.uid)
                                  .get();
    
    const links = [];
    linksSnapshot.forEach(doc => {
      const data = doc.data();
      links.push({
        shortId: data.shortId,
        originalUrl: data.originalUrl,
        clicks: data.clicks,
        createdAt: data.createdAt ? data.createdAt.toDate() : new Date()
      });
    });

    // Ordenar em memória (mais recentes primeiro) para evitar erro de Index no Firestore
    links.sort((a, b) => b.createdAt - a.createdAt);

    res.json({ links });
  } catch (error) {
    console.error("Erro ao buscar estatísticas:", error);
    res.status(500).json({ error: 'Erro no Servidor' });
  }
});

/* =============================================================================
   PAGAMENTOS (Stripe) — plano Lifetime, pagamento unico
   Variaveis de ambiente (Render):
     STRIPE_SECRET_KEY      sk_live_... / sk_test_...
     STRIPE_WEBHOOK_SECRET  whsec_...   (do endpoint criado no painel do Stripe)
     STRIPE_PRICE_LIFETIME  price_...   (preco unico de $1,99)
     PUBLIC_SITE_URL        https://www.neuroqr.online
   Firestore:
     users/{uid}            { plan: 'free' | 'lifetime', planSince, stripe* }
     billing_events/{id}    eventos ja processados (idempotencia do webhook)
   ============================================================================= */
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_PRICE_LIFETIME = process.env.STRIPE_PRICE_LIFETIME || null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || null;
const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://www.neuroqr.online').replace(/\/$/, '');

if (!stripe) console.warn('Stripe desativado: defina STRIPE_SECRET_KEY para ativar os pagamentos.');

// Para pagamentos exigimos SEMPRE um ID token do Firebase (nunca o X-Session-Id),
// para ninguem conseguir comprar/ativar em nome de outro utilizador.
const requireFirebaseUser = async (req, res, next) => {
  if (!db) return res.status(500).json({ error: 'Banco de dados nao inicializado' });
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Inicie sessao para continuar' });
  }
  try {
    req.user = await admin.auth().verifyIdToken(authHeader.slice(7));
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Sessao invalida. Inicie sessao outra vez.' });
  }
};

function serializePlan(uid, data = {}) {
  const since = data.planSince && typeof data.planSince.toDate === 'function' ? data.planSince.toDate().toISOString() : null;
  return {
    uid,
    plan: data.plan === 'lifetime' ? 'lifetime' : 'free',
    planSince: since,
    stripeCustomerId: data.stripeCustomerId || null,
  };
}

async function getPlan(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return serializePlan(uid, snap.exists ? snap.data() : {});
}

async function grantLifetime(session, source) {
  const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
  if (!uid) {
    console.warn('Checkout sem uid associado:', session.id);
    return null;
  }
  const ref = db.collection('users').doc(uid);
  await ref.set({
    plan: 'lifetime',
    planSince: admin.firestore.FieldValue.serverTimestamp(),
    stripeCustomerId: session.customer || null,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: session.payment_intent || null,
    amountTotal: session.amount_total || null,
    currency: session.currency || null,
    billingEmail: (session.customer_details && session.customer_details.email) || session.customer_email || null,
    planSource: source,
  }, { merge: true });
  const snap = await ref.get();
  return serializePlan(uid, snap.data());
}

// Plano do utilizador autenticado
app.get('/api/billing/me', requireFirebaseUser, async (req, res) => {
  try {
    res.json(await getPlan(req.user.uid));
  } catch (error) {
    console.error('Erro ao ler plano:', error);
    res.status(500).json({ error: 'Erro ao ler o plano' });
  }
});

// Cria a sessao de Checkout (pagamento unico) e devolve o URL do Stripe
app.post('/api/billing/checkout', requireFirebaseUser, async (req, res) => {
  if (!stripe || !STRIPE_PRICE_LIFETIME) {
    return res.status(503).json({ error: 'Os pagamentos ainda nao estao configurados no servidor.' });
  }
  try {
    const current = await getPlan(req.user.uid);
    if (current.plan === 'lifetime') {
      return res.status(409).json({ error: 'Esta conta ja tem o plano Lifetime.', plan: current });
    }
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: STRIPE_PRICE_LIFETIME, quantity: 1 }],
      client_reference_id: req.user.uid,
      customer_email: req.user.email || undefined,
      metadata: { uid: req.user.uid, plan: 'lifetime' },
      allow_promotion_codes: true,
      success_url: `${PUBLIC_SITE_URL}/upgrade?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_SITE_URL}/upgrade?status=cancel`,
    });
    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('Erro ao criar checkout:', error);
    // A mensagem do Stripe (ex.: "No such price") ajuda a diagnosticar e nao expoe segredos
    const detail = error && error.message ? ` (${error.type || 'Stripe'}: ${error.message})` : '';
    res.status(500).json({ error: `Nao foi possivel iniciar o pagamento.${detail}` });
  }
});

// Diagnostico (publico, so devolve sim/nao): confirma que variaveis o servidor ve
app.get('/api/billing/config', (req, res) => {
  res.json({
    stripeKey: !!process.env.STRIPE_SECRET_KEY,
    stripeKeyMode: process.env.STRIPE_SECRET_KEY ? (process.env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test') : null,
    webhookSecret: !!STRIPE_WEBHOOK_SECRET,
    priceId: !!STRIPE_PRICE_LIFETIME,
    priceIdLooksValid: !!STRIPE_PRICE_LIFETIME && /^price_/.test(STRIPE_PRICE_LIFETIME),
    publicSiteUrl: PUBLIC_SITE_URL,
  });
});

// Confirmacao directa ao voltar do Stripe (nao depende do webhook ter chegado primeiro)
app.get('/api/billing/confirm', requireFirebaseUser, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Os pagamentos ainda nao estao configurados no servidor.' });
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'session_id em falta' });
  try {
    const session = await stripe.checkout.sessions.retrieve(String(sessionId));
    const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
    if (uid !== req.user.uid) return res.status(403).json({ error: 'Esta sessao de pagamento nao pertence a esta conta.' });
    if (session.payment_status !== 'paid') {
      return res.json({ ...(await getPlan(req.user.uid)), pending: true });
    }
    const plan = await grantLifetime(session, 'confirm');
    res.json(plan);
  } catch (error) {
    console.error('Erro ao confirmar checkout:', error);
    res.status(500).json({ error: 'Nao foi possivel confirmar o pagamento.' });
  }
});

// Webhook do Stripe (corpo em bruto; ver middleware no topo)
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe nao configurado');
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    // Destinos "thin" (Workbench novo) enviam um v2.core.event: a biblioteca exige o metodo proprio
    let isV2 = false;
    try { isV2 = JSON.parse(req.body.toString('utf8')).object === 'v2.core.event'; } catch (_) { isV2 = false; }
    event = isV2
      ? stripe.parseEventNotification(req.body, sig, STRIPE_WEBHOOK_SECRET)
      : stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('Assinatura do webhook invalida:', err.message, '| tem header:', !!req.headers['stripe-signature'], '| body e Buffer:', Buffer.isBuffer(req.body));
    return res.status(400).send(`Webhook Error: ${err.message} | signature header: ${req.headers['stripe-signature'] ? 'yes' : 'no'} | raw body: ${Buffer.isBuffer(req.body) ? 'yes' : 'no'} | path: ${req.originalUrl}`);
  }

  try {
    // Idempotencia: o Stripe pode reenviar o mesmo evento
    const eventRef = db.collection('billing_events').doc(event.id);
    if ((await eventRef.get()).exists) return res.json({ received: true, duplicate: true });

    // Destinos "thin" (Workbench novo): o evento traz so o id do objeto; vamos busca-lo ao Stripe
    const isThin = typeof event.type === 'string' && event.type.startsWith('v1.');
    const type = isThin ? event.type.slice(3) : event.type;
    const loadObject = async () => {
      if (!isThin) return event.data.object;
      const related = event.related_object || {};
      if (type.startsWith('checkout.session.')) return stripe.checkout.sessions.retrieve(related.id);
      if (type.startsWith('charge.')) return stripe.charges.retrieve(related.id);
      return null;
    };

    switch (type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = await loadObject();
        if (session && session.payment_status === 'paid') await grantLifetime(session, 'webhook');
        break;
      }
      case 'charge.refunded': {
        // Reembolso total: volta ao plano gratis
        const charge = await loadObject();
        if (charge && charge.refunded && charge.payment_intent) {
          const q = await db.collection('users').where('stripePaymentIntentId', '==', charge.payment_intent).limit(1).get();
          if (!q.empty) {
            await q.docs[0].ref.set({ plan: 'free', refundedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          }
        }
        break;
      }
      default:
        break;
    }

    await eventRef.set({ type: event.type, livemode: event.livemode, thin: isThin, at: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ received: true });
  } catch (error) {
    console.error('Erro ao processar webhook:', error);
    // 500 faz o Stripe tentar outra vez mais tarde
    res.status(500).send('Erro interno');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend do Beshift rodando na porta ${PORT}`);
});
