import { initializeApp } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

// ==========================================
//  ✅ CONFIGURAÇÃO DO FIREBASE INSERIDA
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyBn7fZl0V97OKEZMUAJcXEa2SB7R1jTjHo",
  authDomain: "beshift.firebaseapp.com",
  projectId: "beshift",
  storageBucket: "beshift.firebasestorage.app",
  messagingSenderId: "174699506644",
  appId: "1:174699506644:web:a8e4378a3765529a858441",
  measurementId: "G-F8EBBBT40B"
};

let app, auth;

try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    console.log("Firebase inicializado com sucesso no Frontend!");
} catch (error) {
    console.error("Erro na Inicialização do Firebase:", error);
}

export { auth };
