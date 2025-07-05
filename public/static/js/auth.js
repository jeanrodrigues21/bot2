class AuthManager {
    constructor() {
        this.initializeElements();
        this.setupEventListeners();
        this.checkExistingAuth();
    }

    initializeElements() {
        // Tabs
        this.tabBtns = document.querySelectorAll('.tab-btn');
        this.loginForm = document.getElementById('loginForm');
        this.registerForm = document.getElementById('registerForm');
        
        // Forms
        this.loginFormElement = document.getElementById('loginForm');
        this.registerFormElement = document.getElementById('registerForm');
        
        // Loading
        this.authLoading = document.getElementById('authLoading');
        this.alertContainer = document.getElementById('alertContainer');
    }

    setupEventListeners() {
        // Tab switching
        this.tabBtns.forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // Form submissions
        this.loginFormElement.addEventListener('submit', (e) => this.handleLogin(e));
        this.registerFormElement.addEventListener('submit', (e) => this.handleRegister(e));
    }

    switchTab(tabName) {
        // Remove active class from all tabs and forms
        this.tabBtns.forEach(btn => btn.classList.remove('active'));
        document.querySelectorAll('.auth-form').forEach(form => form.classList.remove('active'));

        // Add active class to selected tab and form
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}Form`).classList.add('active');

        // Clear alerts
        this.clearAlerts();
    }

    async handleLogin(event) {
        event.preventDefault();
        
        const username = document.getElementById('loginUsername').value;
        const password = document.getElementById('loginPassword').value;

        if (!username || !password) {
            this.showAlert('Por favor, preencha todos os campos', 'error');
            return;
        }

        this.setLoading(true);

        try {
            const response = await fetch('/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                // Salvar token e dados do usuário
                localStorage.setItem('authToken', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                
                this.showAlert('Login realizado com sucesso!', 'success');
                
                // Aguardar um pouco antes de redirecionar para garantir que os dados foram salvos
                setTimeout(() => {
                    // Verificar se os dados foram salvos corretamente
                    const savedToken = localStorage.getItem('authToken');
                    const savedUser = localStorage.getItem('user');
                    
                    if (savedToken && savedUser) {
                        try {
                            const userData = JSON.parse(savedUser);
                            console.log('Redirecionando usuário:', userData);
                            
                            // Redirecionar baseado na role
                            if (userData.role === 'admin') {
                                window.location.href = '/gerenciamento';
                            } else {
                                window.location.href = '/dashboard';
                            }
                        } catch (parseError) {
                            console.error('Erro ao fazer parse dos dados do usuário:', parseError);
                            this.showAlert('Erro nos dados do usuário', 'error');
                        }
                    } else {
                        console.error('Dados não foram salvos corretamente');
                        this.showAlert('Erro ao salvar dados de login', 'error');
                    }
                }, 1500);
            } else {
                this.showAlert(data.error || 'Erro no login', 'error');
            }
        } catch (error) {
            console.error('Erro no login:', error);
            this.showAlert('Erro de conexão. Tente novamente.', 'error');
        } finally {
            this.setLoading(false);
        }
    }

    async handleRegister(event) {
        event.preventDefault();
        
        const username = document.getElementById('registerUsername').value;
        const email = document.getElementById('registerEmail').value;
        const password = document.getElementById('registerPassword').value;
        const confirmPassword = document.getElementById('confirmPassword').value;

        // Validações
        if (!username || !email || !password || !confirmPassword) {
            this.showAlert('Por favor, preencha todos os campos', 'error');
            return;
        }

        if (password !== confirmPassword) {
            this.showAlert('As senhas não coincidem', 'error');
            return;
        }

        if (password.length < 6) {
            this.showAlert('A senha deve ter pelo menos 6 caracteres', 'error');
            return;
        }

        this.setLoading(true);

        try {
            const response = await fetch('/auth/register', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username, email, password })
            });

            const data = await response.json();

            if (response.ok) {
                this.showAlert(data.message, 'success');
                // Limpar formulário
                this.registerFormElement.reset();
                // Voltar para aba de login
                setTimeout(() => {
                    this.switchTab('login');
                }, 2000);
            } else {
                this.showAlert(data.error || 'Erro no cadastro', 'error');
            }
        } catch (error) {
            console.error('Erro no cadastro:', error);
            this.showAlert('Erro de conexão. Tente novamente.', 'error');
        } finally {
            this.setLoading(false);
        }
    }

    checkExistingAuth() {
        // Não verificar autenticação existente automaticamente
        // Isso estava causando redirecionamentos indesejados
        console.log('Verificação de autenticação existente desabilitada para evitar loops');
    }

    showAlert(message, type = 'success') {
        this.clearAlerts();
        
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;
        
        this.alertContainer.appendChild(alert);
        
        // Auto-remove após 5 segundos
        setTimeout(() => {
            if (alert.parentNode) {
                alert.remove();
            }
        }, 5000);
    }

    clearAlerts() {
        this.alertContainer.innerHTML = '';
    }

    setLoading(loading) {
        this.authLoading.style.display = loading ? 'block' : 'none';
        
        // Desabilitar forms durante loading
        const inputs = document.querySelectorAll('input, button[type="submit"]');
        inputs.forEach(input => {
            input.disabled = loading;
        });
    }
}

// Inicializar quando a página carregar
document.addEventListener('DOMContentLoaded', () => {
    new AuthManager();
});