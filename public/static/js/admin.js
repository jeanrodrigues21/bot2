class AdminPanel {
    constructor() {
        this.currentTheme = this.loadTheme();
        this.initializeElements();
        this.setupEventListeners();
        this.applyTheme();
        this.checkAuth();
        this.loadInitialData();
    }

    initializeElements() {
        // Tabs
        this.tabBtns = document.querySelectorAll('.tab-btn');
        this.tabContents = document.querySelectorAll('.tab-content');
        
        // Buttons
        this.themeToggle = document.getElementById('themeToggle');
        this.logoutBtn = document.getElementById('logoutBtn');
        this.createUserBtn = document.getElementById('createUserBtn');
        this.refreshActiveBtn = document.getElementById('refreshActiveBtn');
        
        // Modal
        this.userModal = document.getElementById('userModal');
        this.modalCloseBtn = document.getElementById('modalCloseBtn');
        this.cancelBtn = document.getElementById('cancelBtn');
        this.userForm = document.getElementById('userForm');
        this.modalTitle = document.getElementById('modalTitle');
        
        // Tables and lists
        this.usersTable = document.getElementById('usersTable').querySelector('tbody');
        this.pendingList = document.getElementById('pendingList');
        this.activeList = document.getElementById('activeList');
        
        // Stats
        this.totalUsers = document.getElementById('totalUsers');
        this.approvedUsers = document.getElementById('approvedUsers');
        this.pendingUsers = document.getElementById('pendingUsers');
        this.activeUsers = document.getElementById('activeUsers');
        
        // Loading and alerts
        this.adminLoading = document.getElementById('adminLoading');
        this.alertContainer = document.getElementById('alertContainer');
    }

    setupEventListeners() {
        // Tab switching
        this.tabBtns.forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // Theme toggle
        this.themeToggle.addEventListener('click', () => this.toggleTheme());
        
        // Logout
        this.logoutBtn.addEventListener('click', () => this.logout());
        
        // Modal
        this.createUserBtn.addEventListener('click', () => this.openCreateUserModal());
        this.modalCloseBtn.addEventListener('click', () => this.closeModal());
        this.cancelBtn.addEventListener('click', () => this.closeModal());
        this.userModal.addEventListener('click', (e) => {
            if (e.target === this.userModal) this.closeModal();
        });
        
        // Form
        this.userForm.addEventListener('submit', (e) => this.handleUserForm(e));
        
        // Refresh
        this.refreshActiveBtn.addEventListener('click', () => this.loadActiveUsers());
        
        // ESC key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.userModal.classList.contains('show')) {
                this.closeModal();
            }
        });
    }

    async checkAuth() {
        const token = localStorage.getItem('authToken');
        const user = localStorage.getItem('user');
        
        console.log('Verificando autenticação admin...');
        console.log('Token existe:', !!token);
        console.log('User data existe:', !!user);
        
        if (!token || !user) {
            console.log('Token ou dados do usuário não encontrados, redirecionando para login');
            window.location.href = '/';
            return;
        }
        
        try {
            const userData = JSON.parse(user);
            console.log('Dados do usuário:', userData);
            
            if (userData.role !== 'admin') {
                console.log('Usuário não é admin, redirecionando para dashboard');
                this.showAlert('Acesso negado. Apenas administradores.', 'error');
                setTimeout(() => {
                    window.location.href = '/dashboard';
                }, 2000);
                return;
            }
            
            // Verificar se o token ainda é válido
            const response = await fetch('/auth/verify', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (!response.ok) {
                console.log('Token inválido, redirecionando para login');
                localStorage.removeItem('authToken');
                localStorage.removeItem('user');
                window.location.href = '/';
                return;
            }
            
            console.log('Autenticação admin válida');
        } catch (error) {
            console.error('Erro na verificação de autenticação:', error);
            localStorage.removeItem('authToken');
            localStorage.removeItem('user');
            window.location.href = '/';
        }
    }

    switchTab(tabName) {
        // Remove active class from all tabs and contents
        this.tabBtns.forEach(btn => btn.classList.remove('active'));
        this.tabContents.forEach(content => content.classList.remove('active'));

        // Add active class to selected tab and content
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');

        // Load data for specific tabs
        switch (tabName) {
            case 'users':
                this.loadAllUsers();
                break;
            case 'pending':
                this.loadPendingUsers();
                break;
            case 'active':
                this.loadActiveUsers();
                break;
            case 'stats':
                this.loadStats();
                break;
        }
    }

    loadTheme() {
        return localStorage.getItem('adminTheme') || 'light';
    }

    saveTheme(theme) {
        localStorage.setItem('adminTheme', theme);
    }

    applyTheme() {
        document.documentElement.setAttribute('data-theme', this.currentTheme);
        this.themeToggle.textContent = this.currentTheme === 'dark' ? '☀️ Tema Light' : '🌙 Tema Dark';
    }

    toggleTheme() {
        this.currentTheme = this.currentTheme === 'dark' ? 'light' : 'dark';
        this.saveTheme(this.currentTheme);
        this.applyTheme();
    }

    async logout() {
        try {
            const token = localStorage.getItem('authToken');
            if (token) {
                await this.apiCall('/auth/logout', { method: 'POST' });
            }
        } catch (error) {
            console.error('Erro no logout:', error);
        } finally {
            localStorage.removeItem('authToken');
            localStorage.removeItem('user');
            window.location.href = '/';
        }
    }

    async apiCall(endpoint, options = {}) {
        const token = localStorage.getItem('authToken');
        
        const response = await fetch(`${endpoint}`, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...options.headers
            },
            ...options
        });

        if (response.status === 401 || response.status === 403) {
            console.log('Token inválido ou acesso negado, redirecionando para login');
            localStorage.removeItem('authToken');
            localStorage.removeItem('user');
            window.location.href = '/';
            return;
        }

        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Erro na API');
        }
        
        return data;
    }

    async loadInitialData() {
        await this.loadAllUsers();
        await this.loadStats();
    }

    async loadAllUsers() {
        try {
            const users = await this.apiCall('/admin/users');
            this.renderUsersTable(users);
        } catch (error) {
            console.error('Erro ao carregar usuários:', error);
            this.showAlert('Erro ao carregar usuários', 'error');
        }
    }

    renderUsersTable(users) {
        this.usersTable.innerHTML = '';
        
        users.forEach(user => {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${user.id}</td>
                <td>${user.username}</td>
                <td>${user.email}</td>
                <td><span class="role-badge role-${user.role}">${user.role}</span></td>
                <td><span class="status-badge status-${user.approved ? 'approved' : 'pending'}">${user.approved ? 'Aprovado' : 'Pendente'}</span></td>
                <td>${new Date(user.created_at).toLocaleDateString('pt-BR')}</td>
                <td>${user.last_access ? new Date(user.last_access).toLocaleDateString('pt-BR') : 'Nunca'}</td>
                <td>${user.access_count || 0}</td>
                <td>
                    <button class="btn btn-secondary" onclick="adminPanel.editUser(${user.id})">✏️ Editar</button>
                    ${user.username !== 'jean' ? `<button class="btn btn-danger" onclick="adminPanel.deleteUser(${user.id})">🗑️ Excluir</button>` : ''}
                </td>
            `;
            this.usersTable.appendChild(row);
        });
    }

    async loadPendingUsers() {
        try {
            const users = await this.apiCall('/admin/users/pending');
            this.renderPendingUsers(users);
        } catch (error) {
            console.error('Erro ao carregar usuários pendentes:', error);
            this.showAlert('Erro ao carregar usuários pendentes', 'error');
        }
    }

    renderPendingUsers(users) {
        if (users.length === 0) {
            this.pendingList.innerHTML = '<div class="loading">Nenhum usuário pendente de aprovação</div>';
            return;
        }

        this.pendingList.innerHTML = '';
        
        users.forEach(user => {
            const item = document.createElement('div');
            item.className = 'pending-item';
            item.innerHTML = `
                <div class="pending-header">
                    <div class="pending-info">
                        <h3>${user.username}</h3>
                        <p>📧 ${user.email}</p>
                        <p>📅 Cadastrado em: ${new Date(user.created_at).toLocaleString('pt-BR')}</p>
                    </div>
                    <div class="pending-actions">
                        <button class="btn btn-success" onclick="adminPanel.approveUser(${user.id})">✅ Aprovar</button>
                        <button class="btn btn-danger" onclick="adminPanel.rejectUser(${user.id})">❌ Rejeitar</button>
                    </div>
                </div>
            `;
            this.pendingList.appendChild(item);
        });
    }

    async loadActiveUsers() {
        try {
            const users = await this.apiCall('/admin/users/active');
            this.renderActiveUsers(users);
        } catch (error) {
            console.error('Erro ao carregar usuários ativos:', error);
            this.showAlert('Erro ao carregar usuários ativos', 'error');
        }
    }

    renderActiveUsers(users) {
        if (users.length === 0) {
            this.activeList.innerHTML = '<div class="loading">Nenhum usuário ativo no momento</div>';
            return;
        }

        this.activeList.innerHTML = '';
        
        users.forEach(user => {
            const item = document.createElement('div');
            item.className = 'active-item';
            item.innerHTML = `
                <div class="active-header">
                    <div class="active-info">
                        <h3>🟢 ${user.username}</h3>
                        <p>📧 ${user.email}</p>
                        <p>🕐 Sessão iniciada: ${new Date(user.session_start).toLocaleString('pt-BR')}</p>
                    </div>
                </div>
            `;
            this.activeList.appendChild(item);
        });
    }

    async loadStats() {
        try {
            const stats = await this.apiCall('/admin/stats');
            this.updateStats(stats);
        } catch (error) {
            console.error('Erro ao carregar estatísticas:', error);
            this.showAlert('Erro ao carregar estatísticas', 'error');
        }
    }

    updateStats(stats) {
        this.totalUsers.textContent = stats.totalUsers;
        this.approvedUsers.textContent = stats.approvedUsers;
        this.pendingUsers.textContent = stats.pendingUsers;
        this.activeUsers.textContent = stats.activeUsers;
    }

    async approveUser(userId) {
        if (!confirm('Tem certeza que deseja aprovar este usuário?')) return;
        
        try {
            await this.apiCall(`/admin/users/${userId}/approve`, { method: 'POST' });
            this.showAlert('Usuário aprovado com sucesso!', 'success');
            this.loadPendingUsers();
            this.loadStats();
        } catch (error) {
            console.error('Erro ao aprovar usuário:', error);
            this.showAlert('Erro ao aprovar usuário', 'error');
        }
    }

    async rejectUser(userId) {
        if (!confirm('Tem certeza que deseja rejeitar e remover este usuário?')) return;
        
        try {
            await this.apiCall(`/admin/users/${userId}/reject`, { method: 'DELETE' });
            this.showAlert('Usuário rejeitado e removido', 'success');
            this.loadPendingUsers();
            this.loadStats();
        } catch (error) {
            console.error('Erro ao rejeitar usuário:', error);
            this.showAlert('Erro ao rejeitar usuário', 'error');
        }
    }

    openCreateUserModal() {
        this.modalTitle.textContent = 'Criar Usuário';
        this.userForm.reset();
        document.getElementById('userId').value = '';
        document.getElementById('password').required = true;
        this.userModal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    async editUser(userId) {
        try {
            const user = await this.apiCall(`/admin/users/${userId}`);
            
            this.modalTitle.textContent = 'Editar Usuário';
            document.getElementById('userId').value = user.id;
            document.getElementById('username').value = user.username;
            document.getElementById('email').value = user.email;
            document.getElementById('role').value = user.role;
            document.getElementById('approved').checked = user.approved;
            document.getElementById('password').required = false;
            
            this.userModal.classList.add('show');
            document.body.style.overflow = 'hidden';
        } catch (error) {
            console.error('Erro ao carregar usuário:', error);
            this.showAlert('Erro ao carregar dados do usuário', 'error');
        }
    }

    async deleteUser(userId) {
        if (!confirm('Tem certeza que deseja excluir este usuário? Esta ação não pode ser desfeita.')) return;
        
        try {
            await this.apiCall(`/admin/users/${userId}`, { method: 'DELETE' });
            this.showAlert('Usuário excluído com sucesso!', 'success');
            this.loadAllUsers();
            this.loadStats();
        } catch (error) {
            console.error('Erro ao excluir usuário:', error);
            this.showAlert('Erro ao excluir usuário', 'error');
        }
    }

    closeModal() {
        this.userModal.classList.remove('show');
        document.body.style.overflow = '';
        this.userForm.reset();
    }

    async handleUserForm(event) {
        event.preventDefault();
        
        const userId = document.getElementById('userId').value;
        const userData = {
            username: document.getElementById('username').value,
            email: document.getElementById('email').value,
            role: document.getElementById('role').value,
            approved: document.getElementById('approved').checked
        };
        
        const password = document.getElementById('password').value;
        if (password) {
            userData.password = password;
        }
        
        try {
            if (userId) {
                // Editar usuário
                await this.apiCall(`/admin/users/${userId}`, {
                    method: 'PUT',
                    body: JSON.stringify(userData)
                });
                this.showAlert('Usuário atualizado com sucesso!', 'success');
            } else {
                // Criar usuário
                if (!password) {
                    this.showAlert('Senha é obrigatória para novos usuários', 'error');
                    return;
                }
                await this.apiCall('/admin/users', {
                    method: 'POST',
                    body: JSON.stringify(userData)
                });
                this.showAlert('Usuário criado com sucesso!', 'success');
            }
            
            this.closeModal();
            this.loadAllUsers();
            this.loadStats();
        } catch (error) {
            console.error('Erro ao salvar usuário:', error);
            this.showAlert('Erro ao salvar usuário', 'error');
        }
    }

    showAlert(message, type = 'success') {
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;
        
        this.alertContainer.appendChild(alert);
        
        setTimeout(() => {
            if (alert.parentNode) {
                alert.remove();
            }
        }, 5000);
    }

    setLoading(loading) {
        this.adminLoading.style.display = loading ? 'block' : 'none';
    }
}

// Inicializar quando a página carregar
document.addEventListener('DOMContentLoaded', () => {
    window.adminPanel = new AdminPanel();
});