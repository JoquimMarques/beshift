import { auth } from './firebase-config.js';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.9.0/firebase-auth.js";

// ==========================================
//  ⚙️ API CONFIGURATION
// ==========================================
// Altere isso para a URL do seu Backend no Render antes de enviar para a Vercel
const API_BASE_URL = 'https://beshift.onrender.com'; 

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
    if (window.location.pathname.includes('dashboard.html') || window.location.pathname.endsWith('/dashboard')) {
        document.getElementById('linksGrid').innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: #EF4444; padding: 2rem;">Firebase não configurado. Por favor, adicione suas credenciais em js/firebase-config.js</div>';
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
            const addLinkModal = document.getElementById('addLinkModal');
            if(addLinkModal) addLinkModal.classList.add('hidden');
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
    const linksGrid = document.getElementById('linksGrid');
    if(!linksGrid) return; // Se não estivermos no dashboard
    
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
        
        linksGrid.innerHTML = '';
        
        if (data.links.length === 0) {
            linksGrid.innerHTML = '<div style="text-align: center; padding: 3rem; width: 100%; grid-column: 1 / -1; color: var(--text-muted);">Nenhum link encontrado. Clique no botão de + para criar!</div>';
            return;
        }
        
        data.links.forEach(link => {
            const shortUrl = `${API_BASE_URL}/${link.shortId}`;
            const date = new Date(link.createdAt).toLocaleDateString('pt-BR');
            
            const card = document.createElement('div');
            card.className = 'link-card';
            
            card.innerHTML = `
                <div class="card-header">
                    <span class="card-date">${date}</span>
                    <span class="clicks" title="Visualizações">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M12 4C5 4 1 12 1 12C1 12 5 20 12 20C19 20 23 12 23 12C23 12 19 4 12 4ZM12 17C9.23858 17 7 14.7614 7 12C7 9.2386 9.23858 7 12 7C14.7614 7 17 9.2386 17 12C17 14.7614 14.7614 17 12 17ZM12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9Z" fill="currentColor"/>
                        </svg>
                        ${link.clicks}
                    </span>
                </div>
                <div class="card-body">
                    <a href="${shortUrl}" target="_blank" class="short-url">beshift.com/${link.shortId}</a>
                    <a href="${link.originalUrl}" target="_blank" class="original-url" title="${link.originalUrl}">${link.originalUrl}</a>
                </div>
                <div class="card-footer">
                    <div class="card-actions">
                        <button class="btn-icon btn-copy" data-url="${shortUrl}" title="Copiar URL">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                        </button>
                        <button class="btn-icon stats btn-stats" data-id="${link.shortId}" title="Estatísticas">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"></path><path d="M12 20V4"></path><path d="M6 20v-6"></path></svg>
                        </button>
                    </div>
                </div>
            `;
            linksGrid.appendChild(card);
        });
        
        // Adicionar eventos de copiar
        document.querySelectorAll('.btn-copy').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const btnElement = e.currentTarget;
                const url = btnElement.getAttribute('data-url');
                navigator.clipboard.writeText(url).then(() => {
                    const originalHTML = btnElement.innerHTML;
                    btnElement.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                    btnElement.style.color = '#10B981';
                    
                    setTimeout(() => {
                        btnElement.innerHTML = originalHTML;
                        btnElement.style.color = '';
                    }, 2000);
                    showNotification('Copiado para a área de transferência!');
                });
            });
        });
        
        // Adicionar eventos de estatísticas
        document.querySelectorAll('.btn-stats').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const shortId = e.currentTarget.getAttribute('data-id');
                openStatsModal(shortId);
            });
        });
        
    } catch (error) {
        console.error("Erro ao buscar estatísticas:", error);
        linksGrid.innerHTML = `<div style="text-align: center; color: #EF4444; padding: 2rem; grid-column: 1 / -1;">Erro ao carregar os links: Verifique se o backend está rodando.</div>`;
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
    const addLinkModal = document.getElementById('addLinkModal');
    if (e.target === addLinkModal) {
        addLinkModal.classList.add('hidden');
    }
});

// Lógica do Modal FAB
const fabAddLink = document.getElementById('fabAddLink');
const addLinkModal = document.getElementById('addLinkModal');
const closeAddLinkBtn = document.getElementById('closeAddLinkBtn');

if (fabAddLink) {
    fabAddLink.addEventListener('click', () => {
        addLinkModal.classList.remove('hidden');
        document.getElementById('originalUrl').focus();
    });
}

if (closeAddLinkBtn) {
    closeAddLinkBtn.addEventListener('click', () => {
        addLinkModal.classList.add('hidden');
    });
}

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
