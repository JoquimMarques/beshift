const express = require('express');
const cors = require('cors');
const { nanoid } = require('nanoid');
const admin = require('firebase-admin');
const geoip = require('geoip-lite');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend do Beshift rodando na porta ${PORT}`);
});
