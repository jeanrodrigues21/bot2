class TradingDashboard {
    constructor() {
        this.ws = null;
        this.connected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectInterval = 5000;
        this.currentTheme = this.loadTheme();
        this.balanceUpdateInterval = null;
        
        // NOVO: Estado para trading dinâmico
        this.currentTradingMode = 'single';
        this.monitoredCoinsData = {};
        this.hasActivePosition = false;
        this.activeCoinInOperation = null;
        
        this.initializeElements();
        this.setupEventListeners();
        this.applyTheme();
        this.checkAuth(); // Verificar autenticação
        this.connect();
        this.loadInitialData();
        this.startBalanceUpdates();
    }

    initializeElements() {
        // Controles
        this.startBtn = document.getElementById('startBtn');
        this.stopBtn = document.getElementById('stopBtn');
        this.forceCheckBtn = document.getElementById('forceCheckBtn');
        this.closePositionsBtn = document.getElementById('closePositionsBtn');
        this.refreshBalanceBtn = document.getElementById('refreshBalanceBtn');
        this.themeToggle = document.getElementById('themeToggle');
        
        // Status
        this.statusIndicator = document.getElementById('statusIndicator');
        this.connectionStatus = document.getElementById('connectionStatus');
        
        // Stats
        this.currentPrice = document.getElementById('currentPrice');
        this.dailyTrades = document.getElementById('dailyTrades');
        this.totalProfit = document.getElementById('totalProfit');
        this.activeCoin = document.getElementById('activeCoin');
        this.usdtBalance = document.getElementById('usdtBalance');
        this.btcBalance = document.getElementById('btcBalance');
        this.dailyLow = document.getElementById('dailyLow');
        this.dailyHigh = document.getElementById('dailyHigh');
        
        // Forms e containers
        this.configForm = document.getElementById('configForm');
        this.positionsList = document.getElementById('positionsList');
        this.logContainer = document.getElementById('logContainer');
        this.alertContainer = document.getElementById('alertContainer');
        this.controlsLoading = document.getElementById('controlsLoading');
        this.configBtn = document.getElementById('configBtn');
        this.configModal = document.getElementById('configModal');
        this.configCloseBtn = document.getElementById('configCloseBtn');

        // NOVO: Elementos para trading dinâmico
        this.monitoredCoinsCard = document.getElementById('monitoredCoinsCard');
        this.monitoredCoinsList = document.getElementById('monitoredCoinsList');
        this.tradingModeSelect = document.getElementById('tradingMode');
        this.singleSymbolGroup = document.getElementById('singleSymbolGroup');
        this.dynamicCoinsGroup = document.getElementById('dynamicCoinsGroup');
        
        // NOVO: Elementos para sistema de porcentagem
        this.tradeAmountPercent = document.getElementById('tradeAmountPercent');
        this.minTradeAmountUsdt = document.getElementById('minTradeAmountUsdt');
        this.maxTradeAmountUsdt = document.getElementById('maxTradeAmountUsdt');
        this.tradePreview = document.getElementById('tradePreview');
        
        // NOVO: Elementos para estratégias
        this.originalStrategyPercent = document.getElementById('originalStrategyPercent');
        this.reinforcementStrategyPercent = document.getElementById('reinforcementStrategyPercent');
        this.previewOriginal = document.getElementById('previewOriginal');
        this.previewReinforcement = document.getElementById('previewReinforcement');

        // NOVO: Card de variação diária
        this.dailyVariationCard = document.querySelector('.card h3').parentElement;
        this.dailyVariationTitle = document.querySelector('.card h3');

        // Tabs
        this.tabBtns = document.querySelectorAll('.tab-btn');
        this.tabContents = document.querySelectorAll('.tab-content');
    }

    // CORRIGIDO: Verificar autenticação do usuário
    async checkAuth() {
        const token = localStorage.getItem('authToken');
        const user = localStorage.getItem('user');
        
        console.log('🔐 Verificando autenticação do usuário...');
        console.log('🔑 Token existe:', !!token);
        console.log('👤 User data existe:', !!user);
        
        if (!token || !user) {
            console.log('❌ Token ou dados do usuário não encontrados, redirecionando para login');
            this.redirectToLogin();
            return false;
        }
        
        try {
            const userData = JSON.parse(user);
            console.log('👤 Dados do usuário:', userData);
            
            // Verificar se o token ainda é válido
            console.log('🔍 Verificando validade do token com servidor...');
            const response = await fetch('/auth/verify', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log('📡 Resposta da verificação:', response.status, response.statusText);
            
            if (!response.ok) {
                console.log('❌ Token inválido, redirecionando para login');
                this.redirectToLogin();
                return false;
            }
            
            const verifyData = await response.json();
            console.log('✅ Token válido:', verifyData);
            console.log('✅ Autenticação válida para usuário:', userData.username);
            return true;
        } catch (error) {
            console.error('❌ Erro na verificação de autenticação:', error);
            this.redirectToLogin();
            return false;
        }
    }

    redirectToLogin() {
        console.log('🔄 Redirecionando para login...');
        localStorage.removeItem('authToken');
        localStorage.removeItem('user');
        window.location.href = '/';
    }

    setupEventListeners() {
        this.startBtn.addEventListener('click', () => this.startBot());
        this.stopBtn.addEventListener('click', () => this.stopBot());
        this.forceCheckBtn.addEventListener('click', () => this.forceCheck());
        this.closePositionsBtn.addEventListener('click', () => this.closePositions());
        this.refreshBalanceBtn.addEventListener('click', () => this.refreshBalance());
        this.configForm.addEventListener('submit', (e) => this.saveConfig(e));
        this.themeToggle.addEventListener('click', () => this.toggleTheme());

        this.configBtn.addEventListener('click', () => this.openConfigModal());
        this.configCloseBtn.addEventListener('click', () => this.closeConfigModal());
        this.configModal.addEventListener('click', (e) => {
            if (e.target === this.configModal) {
                this.closeConfigModal();
            }
        });

        // Tab navigation
        this.tabBtns.forEach(btn => {
            btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
        });

        // NOVO: Event listeners para trading dinâmico
        if (this.tradingModeSelect) {
            this.tradingModeSelect.addEventListener('change', () => this.handleTradingModeChange());
        }

        // NOVO: Event listeners para sistema de porcentagem
        if (this.tradeAmountPercent) {
            this.tradeAmountPercent.addEventListener('input', () => this.updateTradePreview());
        }
        if (this.minTradeAmountUsdt) {
            this.minTradeAmountUsdt.addEventListener('input', () => this.updateTradePreview());
        }
        if (this.maxTradeAmountUsdt) {
            this.maxTradeAmountUsdt.addEventListener('input', () => this.updateTradePreview());
        }

        // NOVO: Event listeners para estratégias
        if (this.originalStrategyPercent) {
            this.originalStrategyPercent.addEventListener('input', () => this.updateAllocationPreview());
        }

        // Fechar modal com ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.configModal.classList.contains('show')) {
                this.closeConfigModal();
            }
        });

        // Handle orientation changes on mobile
        window.addEventListener('orientationchange', () => {
            setTimeout(() => this.handleResize(), 100);
        });

        // Handle window resize
        window.addEventListener('resize', () => this.handleResize());
    }

    // NOVO: Manipular mudança de modo de trading
    handleTradingModeChange() {
        const mode = this.tradingModeSelect.value;
        
        console.log('🔄 Modo de trading alterado para:', mode);
        
        this.currentTradingMode = mode;
        
        if (mode === 'dynamic') {
            this.singleSymbolGroup.style.display = 'none';
            this.dynamicCoinsGroup.style.display = 'block';
            this.updateDynamicInterface();
        } else {
            this.singleSymbolGroup.style.display = 'block';
            this.dynamicCoinsGroup.style.display = 'none';
            this.updateSingleInterface();
        }
    }

    // NOVO: Atualizar interface para modo dinâmico
    updateDynamicInterface() {
        if (this.hasActivePosition && this.activeCoinInOperation) {
            // Modo focado: mostrando apenas a moeda em operação
            this.monitoredCoinsCard.style.display = 'none';
            this.updateDailyVariationTitle(`Variação de ${this.activeCoinInOperation}`);
            this.showFocusedCoinData();
        } else {
            // Modo panorâmico: mostrando todas as 10 moedas
            this.monitoredCoinsCard.style.display = 'block';
            this.updateDailyVariationTitle('Panorama do Mercado');
            this.showMarketOverview();
        }
    }

    // NOVO: Atualizar interface para modo single
    updateSingleInterface() {
        this.monitoredCoinsCard.style.display = 'none';
        this.updateDailyVariationTitle('Variação da Moeda Ativa');
    }

    // NOVO: Atualizar título da seção de variação diária
    updateDailyVariationTitle(title) {
        // Encontrar o card de variação diária
        const cards = document.querySelectorAll('.card');
        for (const card of cards) {
            const h3 = card.querySelector('h3');
            if (h3 && (h3.textContent.includes('Variação') || h3.textContent.includes('Panorama'))) {
                h3.textContent = title;
                break;
            }
        }
    }

    // NOVO: Mostrar dados focados da moeda em operação
    showFocusedCoinData() {
        const coinData = this.monitoredCoinsData[this.activeCoinInOperation];
        if (coinData) {
            // Calcular mínima e máxima aproximadas baseadas no preço atual e variação 24h
            const currentPrice = coinData.currentPrice;
            const change24h = coinData.priceChange24h;
            
            // Estimativa aproximada baseada na variação de 24h
            const estimatedRange = Math.abs(change24h) / 100;
            const estimatedLow = currentPrice * (1 - estimatedRange);
            const estimatedHigh = currentPrice * (1 + estimatedRange);
            
            this.dailyLow.textContent = this.formatCurrency(estimatedLow);
            this.dailyHigh.textContent = this.formatCurrency(estimatedHigh);
            
            // Adicionar indicador visual de que está em operação
            const variationCard = this.dailyLow.closest('.card');
            if (variationCard) {
                variationCard.style.borderLeft = '4px solid #4CAF50';
                
                // Adicionar nota explicativa
                let note = variationCard.querySelector('.operation-note');
                if (!note) {
                    note = document.createElement('div');
                    note.className = 'operation-note';
                    note.style.cssText = `
                        margin-top: 10px; 
                        font-size: 12px; 
                        color: var(--success-color); 
                        text-align: center;
                        font-weight: bold;
                    `;
                    variationCard.appendChild(note);
                }
                note.textContent = `🔄 Operação ativa em ${this.activeCoinInOperation}`;
            }
        }
    }

    // NOVO: Mostrar panorama geral do mercado
    showMarketOverview() {
        // Calcular médias do mercado para exibir na seção de variação diária
        const coins = Object.values(this.monitoredCoinsData);
        if (coins.length > 0) {
            const avgLow = coins.reduce((sum, coin) => {
                const estimatedLow = coin.currentPrice * (1 - Math.abs(coin.priceChange24h) / 100);
                return sum + estimatedLow;
            }, 0) / coins.length;
            
            const avgHigh = coins.reduce((sum, coin) => {
                const estimatedHigh = coin.currentPrice * (1 + Math.abs(coin.priceChange24h) / 100);
                return sum + estimatedHigh;
            }, 0) / coins.length;
            
            this.dailyLow.textContent = this.formatCurrency(avgLow);
            this.dailyHigh.textContent = this.formatCurrency(avgHigh);
            
            // Remover indicador de operação ativa
            const variationCard = this.dailyLow.closest('.card');
            if (variationCard) {
                variationCard.style.borderLeft = '';
                const note = variationCard.querySelector('.operation-note');
                if (note) {
                    note.remove();
                }
            }
        }
    }

    // NOVO: Atualizar prévia de valor de trade
    updateTradePreview() {
        const percent = parseFloat(this.tradeAmountPercent.value) || 10;
        const minAmount = parseFloat(this.minTradeAmountUsdt.value) || 5;
        const maxAmount = parseFloat(this.maxTradeAmountUsdt.value) || 10000;
        
        // Simular com diferentes saldos
        const sampleBalances = [100, 500, 1000, 5000, 10000];
        
        let previewText = '';
        sampleBalances.forEach(balance => {
            const calculatedAmount = (balance * percent) / 100;
            const finalAmount = Math.max(minAmount, Math.min(calculatedAmount, maxAmount));
            const maxAllowed = balance * 0.99; // 99% do saldo
            const actualAmount = Math.min(finalAmount, maxAllowed);
            
            previewText += `Saldo $${balance}: Trade de $${actualAmount.toFixed(2)}<br>`;
        });
        
        this.tradePreview.innerHTML = previewText;
    }

    // NOVO: Atualizar prévia de alocação
    updateAllocationPreview() {
        const originalPercent = parseFloat(this.originalStrategyPercent.value) || 70;
        const reinforcementPercent = 100 - originalPercent;
        
        this.reinforcementStrategyPercent.value = reinforcementPercent;
        
        const baseAmount = 1000; // $1000 como exemplo
        const originalAmount = (baseAmount * originalPercent) / 100;
        const reinforcementAmount = (baseAmount * reinforcementPercent) / 100;
        
        this.previewOriginal.textContent = `$${originalAmount.toFixed(2)}`;
        this.previewReinforcement.textContent = `$${reinforcementAmount.toFixed(2)}`;
    }

    switchTab(tabName) {
        // Remove active class from all tabs and contents
        this.tabBtns.forEach(btn => btn.classList.remove('active'));
        this.tabContents.forEach(content => content.classList.remove('active'));

        // Add active class to selected tab and content
        document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
        document.getElementById(`${tabName}-tab`).classList.add('active');
    }

    loadTheme() {
        return localStorage.getItem('tradingDashboardTheme') || 'light';
    }

    saveTheme(theme) {
        localStorage.setItem('tradingDashboardTheme', theme);
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

    handleResize() {
        // Force scroll recalculation on mobile
        if (window.innerWidth <= 768) {
            this.positionsList.style.maxHeight = '200px';
            this.logContainer.style.maxHeight = '200px';
            if (this.monitoredCoinsList) {
                this.monitoredCoinsList.style.maxHeight = '200px';
            }
        } else {
            this.positionsList.style.maxHeight = '300px';
            this.logContainer.style.maxHeight = '300px';
            if (this.monitoredCoinsList) {
                this.monitoredCoinsList.style.maxHeight = '300px';
            }
        }
    }

    openConfigModal() {
        this.configModal.classList.add('show');
        document.body.style.overflow = 'hidden';
    }

    closeConfigModal() {
        this.configModal.classList.remove('show');
        document.body.style.overflow = '';
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                this.connected = true;
                this.reconnectAttempts = 0;
                this.updateConnectionStatus(true);
                this.addLog('Conectado ao servidor');
                
                // CORRIGIDO: Autenticar WebSocket com token do usuário
                const token = localStorage.getItem('authToken');
                if (token) {
                    this.ws.send(JSON.stringify({
                        type: 'auth',
                        token: token
                    }));
                }
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    
                    // CORRIGIDO: Processar apenas mensagens do próprio usuário
                    if (data.type === 'auth_success') {
                        this.addLog('Autenticação WebSocket bem-sucedida');
                    } else if (data.type === 'auth_error') {
                        this.addLog('Erro na autenticação WebSocket: ' + data.message);
                        this.redirectToLogin();
                    } else {
                        this.handleMessage(data);
                    }
                } catch (error) {
                    console.error('Erro ao processar mensagem:', error);
                }
            };
            
            this.ws.onclose = () => {
                this.connected = false;
                this.updateConnectionStatus(false);
                this.addLog('Conexão perdida');
                this.attemptReconnect();
            };
            
            this.ws.onerror = (error) => {
                console.error('Erro WebSocket:', error);
                this.addLog('Erro de conexão');
            };
        } catch (error) {
            console.error('Erro ao conectar:', error);
            this.updateConnectionStatus(false);
        }
    }

    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            this.addLog(`Tentativa de reconexão ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        } else {
            this.addLog('Falha ao reconectar. Recarregue a página.');
        }
    }

    handleMessage(data) {
        switch (data.type) {
            case 'status':
                this.updateStatus(data.data);
                break;
            case 'log':
                this.addLog(data.data.message || data.data);
                break;
            case 'coins_update':
                this.updateMonitoredCoins(data.data);
                break;
            default:
                console.log('Mensagem não reconhecida:', data);
        }
    }

    updateStatus(status) {
        // Indicador de status
        this.statusIndicator.className = `status-indicator ${status.isRunning ? 'status-running' : 'status-stopped'}`;
        
        // Stats - CORRIGIDO: Usar dados da moeda ativa
        this.currentPrice.textContent = this.formatCurrency(status.currentPrice);
        this.dailyTrades.textContent = status.dailyTrades;
        this.totalProfit.textContent = this.formatCurrency(status.totalProfit);
        
        // NOVO: Moeda ativa e controle de estado
        if (status.activeCoin && status.activeCoin !== '-') {
            this.activeCoin.textContent = status.activeCoin;
            this.activeCoinInOperation = status.activeCoin;
        } else {
            this.activeCoin.textContent = '-';
            this.activeCoinInOperation = null;
        }
        
        // NOVO: Verificar se há posições ativas
        this.hasActivePosition = status.positions && status.positions.length > 0;
        
        // NOVO: Atualizar interface baseada no modo e estado
        if (this.currentTradingMode === 'dynamic') {
            this.updateDynamicInterface();
        } else {
            // Modo single: usar dados padrão
            this.dailyLow.textContent = this.formatCurrency(status.dailyLow === Infinity ? 0 : status.dailyLow);
            this.dailyHigh.textContent = this.formatCurrency(status.dailyHigh);
        }
        
        // Botões
        this.startBtn.disabled = status.isRunning;
        this.stopBtn.disabled = !status.isRunning;
        
        // Posições
        this.updatePositions(status.positions);
    }

    updatePositions(positions) {
        if (!positions || positions.length === 0) {
            this.positionsList.innerHTML = '<div class="loading">Nenhuma posição aberta</div>';
            return;
        }
        
        const currentPrice = parseFloat(this.currentPrice.textContent.replace(/[$\s,]/g, '')) || 0;
        
        this.positionsList.innerHTML = positions.map(pos => {
            const investedAmount = pos.buyPrice * pos.quantity;
            const currentValue = currentPrice * pos.quantity;
            const profitLoss = currentValue - investedAmount;
            const profitLossPercent = ((profitLoss / investedAmount) * 100);
            const isProfit = profitLoss >= 0;
            
            // NOVO: Determinar tipo de estratégia
            const strategyType = pos.strategyType || 'original';
            const strategyClass = strategyType === 'reinforcement' ? 'position-reinforcement' : 'position-original';
            const strategyLabel = strategyType === 'reinforcement' ? 'REFORÇO' : 'ORIGINAL';
            
            return `
                <div class="position-item">
                    <div class="position-header">
                        <span class="position-type position-buy">COMPRA</span>
                        <span class="position-type ${strategyClass}">${strategyLabel}</span>
                        <span class="position-profit ${isProfit ? 'profit-positive' : 'profit-negative'}">
                            ${isProfit ? '+' : ''}${this.formatCurrency(profitLoss)}
                        </span>
                    </div>
                    <div><strong>Símbolo:</strong> ${pos.symbol || 'BTCUSDT'}</div>
                    <div><strong>Valor Investido:</strong> ${this.formatCurrency(investedAmount)}</div>
                    <div><strong>Valor Atual:</strong> ${this.formatCurrency(currentValue)}</div>
                    <div><strong>Variação:</strong> <span class="${isProfit ? 'profit-positive' : 'profit-negative'}">
                        ${isProfit ? '+' : ''}${profitLossPercent.toFixed(2)}%
                    </span></div>
                    <div><strong>Preço Compra:</strong> ${this.formatCurrency(pos.buyPrice)}</div>
                    <div><strong>Preço Atual:</strong> ${this.formatCurrency(currentPrice)}</div>
                    <div><strong>Quantidade:</strong> ${pos.quantity.toFixed(8)} ${(pos.symbol || 'BTCUSDT').replace('USDT', '')}</div>
                    <div><strong>Data:</strong> ${new Date(pos.timestamp).toLocaleString('pt-BR')}</div>
                </div>
            `;
        }).join('');
    }

    // NOVO: Atualizar moedas monitoradas
    updateMonitoredCoins(coinsData) {
        this.monitoredCoinsData = coinsData || {};
        
        if (!coinsData || Object.keys(coinsData).length === 0) {
            this.monitoredCoinsList.innerHTML = '<div class="loading">Nenhuma moeda sendo monitorada</div>';
            return;
        }
        
        // NOVO: Ordenar moedas por volume (maiores primeiro)
        const sortedCoins = Object.entries(coinsData)
            .sort(([,a], [,b]) => (b.volume || 0) - (a.volume || 0))
            .slice(0, 10); // Top 10 moedas
        
        this.monitoredCoinsList.innerHTML = sortedCoins.map(([symbol, data]) => {
            const changeClass = data.priceChange24h >= 0 ? 'positive' : 'negative';
            const changeSymbol = data.priceChange24h >= 0 ? '+' : '';
            
            // NOVO: Destacar moeda em operação
            const isInOperation = this.hasActivePosition && symbol === this.activeCoinInOperation;
            const operationClass = isInOperation ? 'coin-in-operation' : '';
            
            return `
                <div class="coin-item ${operationClass}">
                    <div class="coin-info">
                        <div class="coin-symbol">
                            ${symbol}
                            ${isInOperation ? '<span class="operation-indicator">🔄</span>' : ''}
                        </div>
                        <div class="coin-price">${this.formatCurrency(data.currentPrice)}</div>
                        <div class="coin-volume">Vol: ${this.formatVolume(data.volume)}</div>
                    </div>
                    <div class="coin-change ${changeClass}">
                        ${changeSymbol}${data.priceChange24h.toFixed(2)}%
                    </div>
                </div>
            `;
        }).join('');
        
        // NOVO: Atualizar interface dinâmica se necessário
        if (this.currentTradingMode === 'dynamic') {
            this.updateDynamicInterface();
        }
    }

    // NOVO: Formatar volume de forma legível
    formatVolume(volume) {
        if (volume >= 1000000000) {
            return (volume / 1000000000).toFixed(1) + 'B';
        } else if (volume >= 1000000) {
            return (volume / 1000000).toFixed(1) + 'M';
        } else if (volume >= 1000) {
            return (volume / 1000).toFixed(1) + 'K';
        }
        return volume.toFixed(0);
    }

    updateConnectionStatus(connected) {
        this.connectionStatus.textContent = connected ? 'Conectado' : 'Desconectado';
        this.connectionStatus.className = `connection-status ${connected ? 'connected' : 'disconnected'}`;
    }

    addLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.textContent = `[${timestamp}] ${message}`;
        
        this.logContainer.appendChild(logEntry);
        this.logContainer.scrollTop = this.logContainer.scrollHeight;
        
        // Manter apenas os últimos 100 logs
        const logs = this.logContainer.children;
        if (logs.length > 100) {
            this.logContainer.removeChild(logs[0]);
        }
    }

    showAlert(message, type = 'success') {
        const alert = document.createElement('div');
        alert.className = `alert alert-${type}`;
        alert.textContent = message;
        
        this.alertContainer.appendChild(alert);
        
        setTimeout(() => {
            alert.remove();
        }, 5000);
    }

    // CORRIGIDO: Função para fazer chamadas da API com token
    async apiCall(endpoint, options = {}) {
        try {
            const token = localStorage.getItem('authToken');
            
            console.log(`🌐 Fazendo chamada API: ${endpoint}`);
            console.log('🔑 Token existe:', !!token);
            
            if (!token) {
                console.error('❌ Token de autenticação não encontrado');
                this.redirectToLogin();
                return;
            }
            
            // CORREÇÃO PRINCIPAL: Garantir que o token seja enviado corretamente
            const headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
                ...options.headers
            };
            
            console.log('📤 Headers da requisição:', {
                'Content-Type': headers['Content-Type'],
                'Authorization': headers['Authorization'] ? `Bearer ${token.substring(0, 20)}...` : 'Não definido'
            });
            
            const response = await fetch(`/api${endpoint}`, {
                method: options.method || 'GET',
                headers: headers,
                body: options.body
            });
            
            console.log(`📥 Resposta da API ${endpoint}:`, response.status, response.statusText);
            
            // Verificar se o token expirou
            if (response.status === 401 || response.status === 403) {
                console.log('❌ Token expirado ou inválido, redirecionando para login');
                this.redirectToLogin();
                return;
            }
            
            const data = await response.json();
            
            if (!response.ok) {
                console.error('❌ Erro na resposta da API:', data);
                throw new Error(data.message || data.error || 'Erro na API');
            }
            
            console.log('✅ Resposta da API bem-sucedida');
            return data;
        } catch (error) {
            console.error('❌ Erro na chamada da API:', error);
            this.showAlert(error.message, 'error');
            throw error;
        }
    }

    async startBot() {
        this.setControlsLoading(true);
        try {
            await this.apiCall('/start', { method: 'POST' });
            this.showAlert('Bot iniciado com sucesso!');
        } catch (error) {
            console.error('Erro ao iniciar bot:', error);
        } finally {
            this.setControlsLoading(false);
        }
    }

    async stopBot() {
        this.setControlsLoading(true);
        try {
            await this.apiCall('/stop', { method: 'POST' });
            this.showAlert('Bot parado com sucesso!');
        } catch (error) {
            console.error('Erro ao parar bot:', error);
        } finally {
            this.setControlsLoading(false);
        }
    }

    async forceCheck() {
        this.setControlsLoading(true);
        try {
            await this.apiCall('/force-check', { method: 'POST' });
            this.showAlert('Verificação forçada executada!');
        } catch (error) {
            console.error('Erro na verificação forçada:', error);
        } finally {
            this.setControlsLoading(false);
        }
    }

    async closePositions() {
        this.setControlsLoading(true);
        try {
            await this.apiCall('/close-positions', { method: 'POST' });
            this.showAlert('Posições fechadas com sucesso!');
        } catch (error) {
            console.error('Erro ao fechar posições:', error);
        } finally {
            this.setControlsLoading(false);
        }
    }

    // Atualizar saldos do banco de dados
    async updateBalanceDisplay() {
        try {
            const response = await this.apiCall('/balance');
            
            this.usdtBalance.textContent = this.formatCurrency(response.usdtBalance);
            this.btcBalance.textContent = response.btcBalance.toFixed(8);
            
            console.log(`Saldos atualizados do banco - PRODUÇÃO`);
        } catch (error) {
            console.error('Erro ao atualizar saldos do banco:', error);
        }
    }

    // Forçar atualização de saldo via API
    async refreshBalance() {
        try {
            const response = await this.apiCall('/balance/update', { method: 'POST' });
            
            this.usdtBalance.textContent = this.formatCurrency(response.usdtBalance);
            this.btcBalance.textContent = response.btcBalance.toFixed(8);
            
            this.showAlert(response.message || 'Saldos atualizados!');
        } catch (error) {
            console.error('Erro ao atualizar saldos via API:', error);
        }
    }

    // Iniciar atualizações automáticas de saldo
    startBalanceUpdates() {
        // Atualizar saldos a cada 30 segundos
        this.balanceUpdateInterval = setInterval(() => {
            this.updateBalanceDisplay();
        }, 30000);
        
        // Primeira atualização imediata
        this.updateBalanceDisplay();
    }

    async saveConfig(event) {
        event.preventDefault();
        
        // NOVO: Coletar moedas dinâmicas selecionadas
        const dynamicCoins = [];
        document.querySelectorAll('.coin-checkbox input[type="checkbox"]:checked').forEach(checkbox => {
            dynamicCoins.push(checkbox.value);
        });
        
        const config = {
            // Trading básico
            symbol: document.getElementById('symbol').value,
            
            // NOVO: Sistema de porcentagem
            tradeAmountPercent: parseFloat(document.getElementById('tradeAmountPercent').value),
            minTradeAmountUsdt: parseFloat(document.getElementById('minTradeAmountUsdt').value),
            maxTradeAmountUsdt: parseFloat(document.getElementById('maxTradeAmountUsdt').value),
            
            // Manter compatibilidade com valor fixo
            tradeAmountUsdt: parseFloat(document.getElementById('tradeAmountPercent').value) || 100,
            
            dailyProfitTarget: parseFloat(document.getElementById('dailyProfit').value),
            stopLossPercent: parseFloat(document.getElementById('stopLoss').value),
            maxDailyTrades: parseInt(document.getElementById('maxTrades').value),
            minPriceChange: parseFloat(document.getElementById('minPriceChange').value),
            
            // NOVO: Trading dinâmico
            tradingMode: document.getElementById('tradingMode').value,
            dynamicCoins: dynamicCoins,
            
            // NOVO: Estratégias
            enableReinforcement: document.getElementById('enableReinforcement').checked,
            originalStrategyPercent: parseFloat(document.getElementById('originalStrategyPercent').value),
            reinforcementStrategyPercent: parseFloat(document.getElementById('reinforcementStrategyPercent').value),
            reinforcementTriggerPercent: parseFloat(document.getElementById('reinforcementTrigger').value),
            
            // API
            apiKey: document.getElementById('apiKey').value,
            apiSecret: document.getElementById('apiSecret').value,
            baseUrl: document.getElementById('baseUrl').value,
            
            // Advanced
            buyThresholdFromLow: parseFloat(document.getElementById('buyThresholdFromLow').value),
            minHistoryForAnalysis: parseInt(document.getElementById('minHistoryForAnalysis').value),
            recentTrendWindow: parseInt(document.getElementById('recentTrendWindow').value),
            buyCooldownSeconds: parseInt(document.getElementById('buyCooldownSeconds').value),
            pricePollInterval: parseInt(document.getElementById('pricePollInterval').value),
            logFrequency: parseInt(document.getElementById('logFrequency').value),
            makerFee: parseFloat(document.getElementById('makerFee').value),
            takerFee: parseFloat(document.getElementById('takerFee').value),
            
            // Nova estratégia
            buyOnDropPercent: parseFloat(document.getElementById('buyOnDropPercent').value),
            
            testMode: false // Sempre produção
        };
        
        try {
            console.log('💾 Salvando configurações:', config);
            await this.apiCall('/config', {
                method: 'POST',
                body: JSON.stringify(config)
            });
            this.showAlert('Configurações salvas com sucesso!');
            this.closeConfigModal();
            
            // Atualizar modo de trading atual
            this.currentTradingMode = config.tradingMode;
            
            // Atualizar interface baseada no modo de trading
            this.handleTradingModeChange();
            
            // Atualizar saldos após mudança de configuração
            setTimeout(() => {
                this.updateBalanceDisplay();
            }, 1000);
        } catch (error) {
            console.error('Erro ao salvar configurações:', error);
        }
    }

    async loadInitialData() {
        try {
            // Carregar status
            const status = await this.apiCall('/status');
            this.updateStatus(status);
            
            // Carregar configurações
            const config = await this.apiCall('/config');
            this.loadConfig(config);
            
        } catch (error) {
            console.error('Erro ao carregar dados iniciais:', error);
        }
    }

    loadConfig(config) {
        if (config) {
            console.log('📋 Carregando configurações:', config);
            
            // Trading básico
            document.getElementById('symbol').value = config.symbol || 'BTCUSDT';
            
            // NOVO: Sistema de porcentagem
            document.getElementById('tradeAmountPercent').value = config.tradeAmountPercent || 10.0;
            document.getElementById('minTradeAmountUsdt').value = config.minTradeAmountUsdt || 5.0;
            document.getElementById('maxTradeAmountUsdt').value = config.maxTradeAmountUsdt || 10000.0;
            
            document.getElementById('dailyProfit').value = config.dailyProfitTarget || 1.0;
            document.getElementById('stopLoss').value = config.stopLossPercent || 2.0;
            document.getElementById('maxTrades').value = config.maxDailyTrades || 10;
            document.getElementById('minPriceChange').value = config.minPriceChange || 0.5;
            
            // NOVO: Trading dinâmico
            const tradingMode = config.tradingMode || 'single';
            document.getElementById('tradingMode').value = tradingMode;
            this.currentTradingMode = tradingMode;
            console.log('🔄 Configurando modo de trading:', tradingMode);
            
            // NOVO: Carregar moedas dinâmicas
            if (config.dynamicCoins && Array.isArray(config.dynamicCoins)) {
                console.log('🪙 Configurando moedas dinâmicas:', config.dynamicCoins);
                
                // Primeiro, desmarcar todas
                document.querySelectorAll('.coin-checkbox input[type="checkbox"]').forEach(checkbox => {
                    checkbox.checked = false;
                });
                
                // Depois, marcar as selecionadas
                config.dynamicCoins.forEach(coin => {
                    const checkbox = document.getElementById(`coin-${coin}`);
                    if (checkbox) {
                        checkbox.checked = true;
                        console.log(`✅ Moeda ${coin} marcada`);
                    } else {
                        console.warn(`⚠️ Checkbox para ${coin} não encontrado`);
                    }
                });
            }
            
            // NOVO: Estratégias
            document.getElementById('enableReinforcement').checked = config.enableReinforcement !== false;
            document.getElementById('originalStrategyPercent').value = config.originalStrategyPercent || 70;
            document.getElementById('reinforcementStrategyPercent').value = config.reinforcementStrategyPercent || 30;
            document.getElementById('reinforcementTrigger').value = config.reinforcementTriggerPercent || 1.0;
            
            // API
            document.getElementById('apiKey').value = config.apiKey || '';
            document.getElementById('apiSecret').value = config.apiSecret || '';
            document.getElementById('baseUrl').value = config.baseUrl || 'https://api.binance.com';
            
            // Advanced
            document.getElementById('buyThresholdFromLow').value = config.buyThresholdFromLow || 0.2;
            document.getElementById('minHistoryForAnalysis').value = config.minHistoryForAnalysis || 20;
            document.getElementById('recentTrendWindow').value = config.recentTrendWindow || 10;
            document.getElementById('buyCooldownSeconds').value = config.buyCooldownSeconds || 300;
            document.getElementById('pricePollInterval').value = config.pricePollInterval || 10;
            document.getElementById('logFrequency').value = config.logFrequency || 60;
            document.getElementById('makerFee').value = config.makerFee || 0.001;
            document.getElementById('takerFee').value = config.takerFee || 0.001;
            
            // Nova estratégia
            document.getElementById('buyOnDropPercent').value = config.buyOnDropPercent || 0.7;
            
            // Atualizar interface
            this.handleTradingModeChange();
            this.updateAllocationPreview();
            this.updateTradePreview();
            
            console.log('✅ Configurações carregadas com sucesso');
        } else {
            console.warn('⚠️ Nenhuma configuração encontrada');
        }
    }

    setControlsLoading(loading) {
        this.controlsLoading.style.display = loading ? 'block' : 'none';
        this.startBtn.disabled = loading;
        this.stopBtn.disabled = loading;
        this.forceCheckBtn.disabled = loading;
        this.closePositionsBtn.disabled = loading;
        this.configBtn.disabled = loading;
    }

    formatCurrency(value) {
        return new Intl.NumberFormat('en-US', {
            style: 'currency',
            currency: 'USD'
        }).format(value || 0);
    }

    // Cleanup ao fechar a página
    destroy() {
        if (this.balanceUpdateInterval) {
            clearInterval(this.balanceUpdateInterval);
        }
        if (this.ws) {
            this.ws.close();
        }
    }
}

// Inicializar dashboard quando a página carregar
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new TradingDashboard();
});

// Cleanup ao fechar a página
window.addEventListener('beforeunload', () => {
    if (window.dashboard) {
        window.dashboard.destroy();
    }
});