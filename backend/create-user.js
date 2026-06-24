const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

async function createUser() {
  try {
    const userRecord = await admin.auth().createUser({
      email: 'admin@beshift.com',
      password: 'beshift.admin123',
      emailVerified: true,
      displayName: 'Admin Beshift',
    });
    console.log('Usuário criado com sucesso:', userRecord.uid);
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
        console.log('O usuário admin@beshift.com já existe. Você pode usá-lo!');
        
        // Se já existe, vamos forçar a alteração da senha para termos certeza de qual é
        try {
            const existingUser = await admin.auth().getUserByEmail('admin@beshift.com');
            await admin.auth().updateUser(existingUser.uid, {
                password: 'beshift.admin123'
            });
            console.log('Senha do usuário atualizada com sucesso!');
        } catch(e) {
            console.error('Erro ao atualizar senha:', e);
        }
        
    } else {
        console.error('Erro ao criar usuário:', error);
    }
  }
  process.exit();
}

createUser();
