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
    
    // Obter IP e País
    let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (ip && ip.includes(',')) ip = ip.split(',')[0].trim();
    
    let country = 'Desconhecido';
    
    if (ip === '::1' || ip === '127.0.0.1') {
        country = 'Localhost (Seu PC) 💻';
    } else {
        const geo = geoip.lookup(ip);
        if (geo && geo.country) {
            const countryNames = {
                'BR': 'Brasil 🇧🇷',
                'PT': 'Portugal 🇵🇹',
                'US': 'Estados Unidos 🇺🇸',
                'AO': 'Angola 🇦🇴',
                'MZ': 'Moçambique 🇲🇿',
                'CV': 'Cabo Verde 🇨🇻'
            };
            country = countryNames[geo.country] || geo.country;
        }
    }

    // Salvar visualização
    const viewRef = linkRef.collection('views').doc();
    const viewPromise = viewRef.set({
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ip: ip || 'Desconhecido',
      country: country
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
