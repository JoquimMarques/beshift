import { auth } from './firebase-config.js';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

// ==========================================
//  ⚙️ API CONFIGURATION
// ==========================================
// Altere isso para a URL do seu Backend no Render antes de enviar para a Vercel
const API_BASE_URL = 'http://localhost:3000'; 

// Elementos do DOM
const notification = document.getElementById('notification');
const navLoginBtn = document.getElementById('navLoginBtn');
const navDashboardBtn = document.getElementById('navDashboardBtn');

// Auxiliar: Mostrar notificação
window.showNotification = (message, type = 'success') => {
    notification.textContent = message;
    notification.className = `show ${type}`;
    setTimeout(() => {
        notification.classList.remove('show');
    }, 3500);
};

// ==========================================
//  🔒 LÓGICA DE AUTENTICAÇÃO
// ==========================================
if (auth) {
    onAuthStateChanged(auth, (user) => {
        const path = window.location.pathname;
        const isDashboard = path.includes('dashboard.html');
        const isLogin = path.includes('login.html');
        
        if (user) {
            // Usuário está logado
            if (navLoginBtn) navLoginBtn.classList.add('hidden');
            if (navDashboardBtn) {
                navDashboardBtn.classList.remove('hidden');
                navDashboardBtn.onclick = () => window.location.href = 'dashboard.html';
            }
            
            if (isLogin) {
                window.location.href = 'dashboard.html';
            }
            
            if (isDashboard) {
                document.getElementById('dashboardBody').style.display = 'block';
                document.getElementById('userEmailDisplay').textContent = user.email;
                fetchStats(user);
            }
        } else {
            // Usuário está deslogado
            if (navLoginBtn) {
                navLoginBtn.classList.remove('hidden');
                navLoginBtn.onclick = () => window.location.href = 'login.html';
            }
            if (navDashboardBtn) navDashboardBtn.classList.add('hidden');
            
            if (isDashboard) {
                window.location.href = 'login.html';
            }
        }
    });
} else {
    // Se a autenticação não foi iniciada devido a falta de configuração
    if (window.location.pathname.includes('dashboard.html')) {
        document.getElementById('dashboardBody').style.display = 'block';
        document.getElementById('linksTableBody').innerHTML = '<tr><td colspan="5" style="text-align: center; color: #EF4444; padding: 2rem;">Firebase não configurado. Por favor, adicione suas credenciais em js/firebase-config.js</td></tr>';
    }
}

// ==========================================
//  🔑 PÁGINA DE LOGIN
// ==========================================
const loginForm = document.getElementById('loginForm');
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if(!auth) {
            showNotification('O Firebase ainda não está configurado.', 'error');
            return;
        }

        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const loginBtn = document.getElementById('loginBtn');
        
        loginBtn.innerHTML = '<span class="loading"></span>';
        loginBtn.disabled = true;
        
        try {
            await signInWithEmailAndPassword(auth, email, password);
            showNotification('Login realizado com sucesso!');
            window.location.href = 'dashboard.html';
        } catch (error) {
            console.error(error);
            showNotification(error.code ? error.code.replace('auth/', '').replace(/-/g, ' ') : error.message, 'error');
            loginBtn.textContent = 'Entrar';
            loginBtn.disabled = false;
        }
    });
}

// ==========================================
//  📊 LÓGICA DO PAINEL (DASHBOARD)
// ==========================================
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        signOut(auth).then(() => {
            window.location.href = 'index.html';
        });
    });
}

const shortenForm = document.getElementById('shortenForm');
if (shortenForm) {
    shortenForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const originalUrl = document.getElementById('originalUrl').value;
        const customAlias = document.getElementById('customAlias').value;
        const shortenBtn = document.getElementById('shortenBtn');
        
        shortenBtn.innerHTML = '<span class="loading"></span>';
        shortenBtn.disabled = true;
        
        try {
            const token = await auth.currentUser.getIdToken();
            const response = await fetch(`${API_BASE_URL}/api/shorten`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ originalUrl, customAlias })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'Falha ao encurtar a URL');
            }
            
            showNotification('URL encurtada com sucesso!');
            document.getElementById('originalUrl').value = '';
            document.getElementById('customAlias').value = '';
            fetchStats(auth.currentUser); 
        } catch (error) {
            showNotification(error.message, 'error');
        } finally {
            shortenBtn.textContent = 'Encurtar';
            shortenBtn.disabled = false;
        }
    });
}

async function fetchStats(user) {
    const tbody = document.getElementById('linksTableBody');
    try {
        const token = await user.getIdToken();
        const response = await fetch(`${API_BASE_URL}/api/stats`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Falha ao buscar estatísticas');
        }
        
        tbody.innerHTML = '';
        
        if (data.links.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem; color: var(--text-muted);">Nenhum link encontrado. Encurte seu primeiro link acima!</td></tr>';
            return;
        }
        
        data.links.forEach(link => {
            const shortUrl = `${API_BASE_URL}/${link.shortId}`;
            const tr = document.createElement('tr');
            
            const date = new Date(link.createdAt).toLocaleDateString('pt-BR');
            
            tr.innerHTML = `
                <td>
                    <a href="${shortUrl}" target="_blank" class="short-url-link">${link.shortId}</a>
                </td>
                <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <a href="${link.originalUrl}" target="_blank" style="color: var(--text-muted); text-decoration: none;" title="${link.originalUrl}">${link.originalUrl}</a>
                </td>
                <td><span class="clicks-badge">${link.clicks}</span></td>
                <td style="color: var(--text-muted); font-size: 0.9rem;">${date}</td>
                <td style="display: flex; gap: 0.5rem;">
                    <button class="btn-copy" data-url="${shortUrl}" style="background: transparent; border: 1px solid var(--glass-border); color: var(--text-main); padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; transition: background 0.3s;">Copiar</button>
                    <button class="btn-stats" data-id="${link.shortId}" style="background: rgba(139, 92, 246, 0.2); border: 1px solid var(--glass-border); color: #C4B5FD; padding: 0.4rem 0.8rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; transition: background 0.3s;">Estatísticas</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Adicionar eventos de copiar
        document.querySelectorAll('.btn-copy').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const url = e.target.getAttribute('data-url');
                navigator.clipboard.writeText(url).then(() => {
                    const originalText = e.target.textContent;
                    e.target.textContent = 'Copiado!';
                    e.target.style.background = 'rgba(16, 185, 129, 0.2)'; // Fundo verde
                    
                    setTimeout(() => {
                        e.target.textContent = originalText;
                        e.target.style.background = 'transparent';
                    }, 2000);
                    showNotification('Copiado para a área de transferência!');
                });
            });
        });
        
        // Adicionar eventos de estatísticas
        document.querySelectorAll('.btn-stats').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const shortId = e.target.getAttribute('data-id');
                openStatsModal(shortId);
            });
        });
        
    } catch (error) {
        console.error("Erro ao buscar estatísticas:", error);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #EF4444; padding: 2rem;">Erro ao carregar os links: Verifique se o backend está rodando.</td></tr>`;
    }
}

// ==========================================
//  🪟 LÓGICA DO MODAL DE ESTATÍSTICAS
// ==========================================
const statsModal = document.getElementById('statsModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const modalLoading = document.getElementById('modalLoading');
const modalData = document.getElementById('modalData');
const modalTableBody = document.getElementById('modalTableBody');

if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => {
        if(statsModal) statsModal.classList.add('hidden');
    });
}

// Fechar modal ao clicar fora
window.addEventListener('click', (e) => {
    if (e.target === statsModal) {
        statsModal.classList.add('hidden');
    }
});

async function openStatsModal(shortId) {
    if(!statsModal) return;
    statsModal.classList.remove('hidden');
    modalLoading.classList.remove('hidden');
    modalData.classList.add('hidden');
    modalTableBody.innerHTML = '';
    
    try {
        const token = await auth.currentUser.getIdToken();
        const response = await fetch(`${API_BASE_URL}/api/stats/${shortId}`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Erro ao carregar estatísticas detalhadas');
        }
        
        if (data.views.length === 0) {
            modalTableBody.innerHTML = '<tr><td colspan="2" style="text-align: center; color: var(--text-muted); padding: 1rem;">Nenhuma visualização detalhada rastreada ainda.</td></tr>';
        } else {
            data.views.forEach(view => {
                const dateObj = new Date(view.timestamp);
                const dateStr = dateObj.toLocaleDateString('pt-BR') + ' ' + dateObj.toLocaleTimeString('pt-BR');
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="color: var(--text-main); font-size: 0.9rem;">${dateStr}</td>
                    <td style="color: var(--secondary); font-size: 0.9rem;">${view.country}</td>
                `;
                modalTableBody.appendChild(tr);
            });
        }
        
        modalLoading.classList.add('hidden');
        modalData.classList.remove('hidden');
        
    } catch (error) {
        modalLoading.classList.add('hidden');
        modalData.classList.remove('hidden');
        modalTableBody.innerHTML = `<tr><td colspan="2" style="text-align: center; color: #EF4444; padding: 1rem;">${error.message}</td></tr>`;
    }
}
