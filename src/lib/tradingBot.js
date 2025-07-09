import logger from './logger.js';
import BinanceAPI from './binanceApi.js';
import BalanceManager from './balanceManager.js';
import DynamicTradingManager from './dynamicTradingManager.js';

export default class TradingBot {
  constructor(config, database, userId = null) {
    this.config = config;
    this.db = database;
    this.userId = userId; // NOVO: ID do usuário específico
    this.isRunning = false;
    
    // CORRIGIDO: Instâncias específicas do usuário
    this.api = new BinanceAPI(config);
    this.balanceManager = new BalanceManager(database, this.api, userId);
    this.dynamicManager = new DynamicTradingManager(config, this.api, database, userId);
    
    // Estado específico do usuário
    this.priceHistory = [];
    this.dailyLow = Infinity;
    this.dailyHigh = 0;
    this.dailyTrades = 0;
    this.totalProfit = 0;
    this.lastBuyTime = null;
    this.activeCoin = null;
    
    // Intervalos e timeouts
    this.priceCheckInterval = null;
    this.logInterval = null;
    this.dailyResetTimeout = null;
    
    // Callbacks para WebSocket (específicos do usuário)
    this.onStatusUpdate = null;
    this.onLogMessage = null;
    this.onCoinsUpdate = null;
    
    // Controle de logs
    this.lastLogTime = 0;
    this.logCounter = 0;
    
    // NOVO: Prefixo para logs do usuário
    this.logPrefix = userId ? `[User ${userId}]` : '[System]';
  }

  // CORRIGIDO: Log específico do usuário
  log(message, level = 'info') {
    const fullMessage = `${this.logPrefix} ${message}`;
    
    if (level === 'error') {
      logger.error(fullMessage);
    } else if (level === 'warn') {
      logger.warn(fullMessage);
    } else {
      logger.info(fullMessage);
    }
    
    // Enviar log via WebSocket apenas para o usuário específico
    if (this.onLogMessage) {
      this.onLogMessage({
        message: fullMessage,
        timestamp: new Date().toISOString(),
        level: level,
        userId: this.userId
      });
    }
  }

  async start() {
    if (this.isRunning) {
      this.log('Bot já está rodando', 'warn');
      return;
    }

    try {
      this.log('Iniciando bot de trading...');
      
      // Testar conexão com a API
      const connectionTest = await this.api.testConnection();
      if (!connectionTest) {
        throw new Error('Falha na conexão com a API Binance');
      }
      
      this.log('Conexão com API Binance estabelecida');
      
      // CORRIGIDO: Carregar estado específico do usuário
      await this.loadUserState();
      
      // Inicializar dynamic trading manager
      if (this.config.tradingMode === 'dynamic') {
        this.log('Inicializando trading dinâmico...');
        await this.dynamicManager.initializeCoinStates();
      }
      
      // Iniciar balance manager
      this.balanceManager.startAutoUpdate(5); // 5 minutos
      
      this.isRunning = true;
      
      // Iniciar monitoramento de preços
      this.startPriceMonitoring();
      
      // Configurar reset diário
      this.scheduleDailyReset();
      
      // Log inicial
      this.log(`Bot iniciado em modo ${this.config.tradingMode === 'dynamic' ? 'dinâmico' : 'single'}`);
      this.log(`Símbolo principal: ${this.config.symbol}`);
      
      if (this.config.tradingMode === 'dynamic') {
        this.log(`Moedas monitoradas: ${this.config.dynamicCoins.join(', ')}`);
      }
      
      // Primeira verificação
      await this.checkPrice();
      
    } catch (error) {
      this.log(`Erro ao iniciar bot: ${error.message}`, 'error');
      this.isRunning = false;
      throw error;
    }
  }

  async stop() {
    if (!this.isRunning) {
      this.log('Bot já está parado', 'warn');
      return;
    }

    try {
      this.log('Parando bot de trading...');
      
      this.isRunning = false;
      
      // Parar intervalos
      if (this.priceCheckInterval) {
        clearInterval(this.priceCheckInterval);
        this.priceCheckInterval = null;
      }
      
      if (this.logInterval) {
        clearInterval(this.logInterval);
        this.logInterval = null;
      }
      
      if (this.dailyResetTimeout) {
        clearTimeout(this.dailyResetTimeout);
        this.dailyResetTimeout = null;
      }
      
      // Parar balance manager
      if (this.balanceManager) {
        this.balanceManager.stopAutoUpdate();
      }
      
      // Parar dynamic manager
      if (this.dynamicManager) {
        this.dynamicManager.destroy();
      }
      
      // CORRIGIDO: Salvar estado específico do usuário
      await this.saveUserState();
      
      this.log('Bot parado com sucesso');
      
    } catch (error) {
      this.log(`Erro ao parar bot: ${error.message}`, 'error');
      throw error;
    }
  }

  // NOVO: Carregar estado específico do usuário
  async loadUserState() {
    try {
      if (!this.userId) return;
      
      const state = await this.db.getUserBotState(this.userId);
      if (state) {
        this.dailyTrades = state.daily_trades || 0;
        this.totalProfit = state.total_profit || 0;
        this.log(`Estado carregado: ${this.dailyTrades} trades, lucro total: $${this.totalProfit.toFixed(2)}`);
      }
      
      // Carregar posições abertas
      const positions = await this.db.getUserOpenPositions(this.userId);
      if (positions.length > 0) {
        this.log(`${positions.length} posições abertas encontradas`);
        // Definir moeda ativa baseada na primeira posição
        this.activeCoin = positions[0].symbol;
      }
      
    } catch (error) {
      this.log(`Erro ao carregar estado do usuário: ${error.message}`, 'error');
    }
  }

  // NOVO: Salvar estado específico do usuário
  async saveUserState() {
    try {
      if (!this.userId) return;
      
      await this.db.updateUserBotState(this.userId, {
        daily_trades: this.dailyTrades,
        total_profit: this.totalProfit,
        last_active: new Date().toISOString()
      });
      
    } catch (error) {
      this.log(`Erro ao salvar estado do usuário: ${error.message}`, 'error');
    }
  }

  startPriceMonitoring() {
    // Verificação de preços
    this.priceCheckInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.checkPrice();
      }
    }, this.config.pricePollInterval * 1000);

    // Log periódico
    this.logInterval = setInterval(() => {
      if (this.isRunning) {
        this.logCurrentStatus();
      }
    }, this.config.logFrequency * 1000);
  }

  async checkPrice() {
    try {
      if (this.config.tradingMode === 'dynamic') {
        // CORRIGIDO: Usar dynamic manager específico do usuário
        await this.dynamicManager.updateAllCoinData();
        
        // Verificar se há posições abertas
        const openPositions = await this.db.getUserOpenPositions(this.userId);
        
        if (openPositions.length > 0) {
          // Modo focado: avaliar posições existentes
          await this.evaluatePositions();
        } else {
          // Modo panorâmico: procurar oportunidades
          await this.lookForBuyOpportunities();
        }
        
        // Atualizar dados de moedas via WebSocket
        if (this.onCoinsUpdate) {
          const coinsData = this.dynamicManager.getAllCoinsStats();
          this.onCoinsUpdate({
            type: 'coins_update',
            data: coinsData
          });
        }
        
      } else {
        // Modo single: lógica tradicional
        await this.checkSingleCoinPrice();
      }
      
      // Atualizar status via WebSocket
      if (this.onStatusUpdate) {
        this.onStatusUpdate(this.getStatus());
      }
      
    } catch (error) {
      this.log(`Erro na verificação de preço: ${error.message}`, 'error');
    }
  }

  // CORRIGIDO: Verificação para modo single específica do usuário
  async checkSingleCoinPrice() {
    try {
      const currentPrice = await this.api.getCurrentPrice(this.config.symbol);
      
      if (currentPrice <= 0) {
        this.log('Preço inválido recebido', 'warn');
        return;
      }
      
      // Atualizar histórico
      this.priceHistory.push({
        price: currentPrice,
        timestamp: new Date()
      });
      
      // Manter apenas os últimos 1000 pontos
      if (this.priceHistory.length > 1000) {
        this.priceHistory.shift();
      }
      
      // Atualizar mínima e máxima
      this.dailyLow = Math.min(this.dailyLow, currentPrice);
      this.dailyHigh = Math.max(this.dailyHigh, currentPrice);
      
      // Salvar no banco específico do usuário
      await this.db.saveUserPricePoint(this.userId, this.config.symbol, {
        price: currentPrice,
        dailyLow: this.dailyLow,
        dailyHigh: this.dailyHigh
      });
      
      // Verificar oportunidades
      await this.evaluatePositions();
      
      const openPositions = await this.db.getUserOpenPositions(this.userId);
      if (openPositions.length === 0) {
        await this.checkBuyConditions(this.config.symbol, currentPrice);
      }
      
    } catch (error) {
      this.log(`Erro na verificação de preço single: ${error.message}`, 'error');
    }
  }

  // CORRIGIDO: Procurar oportunidades específicas do usuário
  async lookForBuyOpportunities() {
    try {
      // Verificar se já atingiu o limite diário
      if (this.dailyTrades >= this.config.maxDailyTrades) {
        return;
      }
      
      // Encontrar melhor moeda para comprar
      const bestCoin = this.dynamicManager.findBestCoinToBuy();
      
      if (bestCoin) {
        const coinState = this.dynamicManager.getCoinState(bestCoin);
        if (coinState) {
          await this.executeBuy(bestCoin, coinState.currentPrice, 'original');
        }
      }
      
    } catch (error) {
      this.log(`Erro ao procurar oportunidades: ${error.message}`, 'error');
    }
  }

  // CORRIGIDO: Verificar condições de compra específicas do usuário
  async checkBuyConditions(symbol, currentPrice) {
    try {
      if (this.dailyTrades >= this.config.maxDailyTrades) {
        return;
      }
      
      if (this.priceHistory.length < this.config.minHistoryForAnalysis) {
        return;
      }
      
      if (this.dailyHigh === this.dailyLow) {
        return;
      }
      
      // Verificar variação diária mínima
      const dailyVariation = ((this.dailyHigh - this.dailyLow) / this.dailyLow) * 100;
      if (dailyVariation < this.config.minPriceChange) {
        return;
      }
      
      // Verificar se está próximo da mínima
      const priceFromLow = ((currentPrice - this.dailyLow) / this.dailyLow) * 100;
      
      if (priceFromLow <= this.config.buyThresholdFromLow) {
        // Verificar tendência de alta
        const recentPrices = this.priceHistory
          .slice(-this.config.recentTrendWindow)
          .map(p => p.price);
        
        if (recentPrices.length >= this.config.recentTrendWindow) {
          const halfLength = Math.floor(recentPrices.length / 2);
          const firstHalfAvg = recentPrices.slice(0, halfLength).reduce((a, b) => a + b, 0) / halfLength;
          const secondHalfAvg = recentPrices.slice(halfLength).reduce((a, b) => a + b, 0) / (recentPrices.length - halfLength);
          
          if (secondHalfAvg > firstHalfAvg) {
            // Verificar cooldown
            if (this.lastBuyTime) {
              const timeSinceLastBuy = (Date.now() - this.lastBuyTime.getTime()) / 1000;
              if (timeSinceLastBuy < this.config.buyCooldownSeconds) {
                return;
              }
            }
            
            await this.executeBuy(symbol, currentPrice, 'original');
          }
        }
      }
      
    } catch (error) {
      this.log(`Erro ao verificar condições de compra: ${error.message}`, 'error');
    }
  }

  // CORRIGIDO: Executar compra específica do usuário
  async executeBuy(symbol, price, strategyType = 'original') {
    try {
      // Verificar saldo
      const balance = await this.balanceManager.getCurrentBalance();
      
      // Calcular valor do trade baseado na estratégia
      let tradeAmount;
      if (strategyType === 'reinforcement') {
        tradeAmount = this.dynamicManager.calculateAllocation(balance.usdtBalance, 'reinforcement');
      } else {
        tradeAmount = this.dynamicManager.calculateAllocation(balance.usdtBalance, 'original');
      }
      
      // Usar sistema de porcentagem se configurado
      if (this.config.tradeAmountPercent) {
        tradeAmount = this.config.calculateTradeAmount(balance.usdtBalance);
      }
      
      if (balance.usdtBalance < tradeAmount) {
        this.log(`Saldo insuficiente: $${balance.usdtBalance.toFixed(2)} < $${tradeAmount.toFixed(2)}`, 'warn');
        return;
      }
      
      // Calcular quantidade
      const quantity = tradeAmount / price;
      
      this.log(`Executando compra ${strategyType}: ${quantity.toFixed(8)} ${symbol} por $${tradeAmount.toFixed(2)}`);
      
      // Executar ordem na Binance
      const order = await this.api.placeOrder('BUY', quantity, null, 'MARKET', symbol);
      
      if (order) {
        // Salvar posição no banco específico do usuário
        await this.db.saveUserPosition(this.userId, {
          symbol: symbol,
          orderId: order.orderId,
          side: 'BUY',
          quantity: parseFloat(order.executedQty || quantity),
          price: parseFloat(order.fills?.[0]?.price || price),
          strategyType: strategyType,
          timestamp: new Date().toISOString()
        });
        
        this.dailyTrades++;
        this.lastBuyTime = new Date();
        this.activeCoin = symbol;
        
        // Atualizar estado no dynamic manager
        if (this.config.tradingMode === 'dynamic') {
          const coinState = this.dynamicManager.getCoinState(symbol);
          if (coinState) {
            coinState.lastBuyTime = this.lastBuyTime;
          }
        }
        
        // Salvar estado
        await this.saveUserState();
        
        this.log(`✅ Compra executada: ${order.executedQty} ${symbol} por $${(parseFloat(order.executedQty) * price).toFixed(2)}`);
      }
      
    } catch (error) {
      this.log(`Erro ao executar compra: ${error.message}`, 'error');
    }
  }

  // CORRIGIDO: Avaliar posições específicas do usuário
  async evaluatePositions() {
    try {
      const positions = await this.db.getUserOpenPositions(this.userId);
      
      if (positions.length === 0) {
        this.activeCoin = null;
        return;
      }
      
      for (const position of positions) {
        const currentPrice = await this.api.getCurrentPrice(position.symbol);
        
        if (currentPrice <= 0) continue;
        
        // Verificar condições de venda
        const sellDecision = this.dynamicManager.shouldSellPosition(position, currentPrice);
        
        if (sellDecision.shouldSell) {
          await this.executeSell(position, currentPrice, sellDecision.reason);
        } else if (this.config.enableReinforcement) {
          // Verificar se deve fazer reforço
          const shouldReinforce = this.dynamicManager.shouldReinforcePosition(position, currentPrice);
          
          if (shouldReinforce) {
            await this.executeBuy(position.symbol, currentPrice, 'reinforcement');
          }
        }
      }
      
    } catch (error) {
      this.log(`Erro ao avaliar posições: ${error.message}`, 'error');
    }
  }

  // CORRIGIDO: Executar venda específica do usuário
  async executeSell(position, currentPrice, reason) {
    try {
      this.log(`Executando venda: ${position.quantity} ${position.symbol} por ${reason}`);
      
      // Executar ordem na Binance
      const order = await this.api.placeOrder('SELL', position.quantity, null, 'MARKET', position.symbol);
      
      if (order) {
        // Calcular lucro
        const sellAmount = parseFloat(order.executedQty || position.quantity);
        const sellPrice = parseFloat(order.fills?.[0]?.price || currentPrice);
        const profit = (sellPrice * sellAmount) - (position.buyPrice * position.quantity);
        
        // Fechar posição no banco
        await this.db.closeUserPosition(this.userId, position.orderId, sellPrice, profit);
        
        this.totalProfit += profit;
        
        // Verificar se ainda há posições abertas
        const remainingPositions = await this.db.getUserOpenPositions(this.userId);
        if (remainingPositions.length === 0) {
          this.activeCoin = null;
        }
        
        // Salvar estado
        await this.saveUserState();
        
        this.log(`✅ Venda executada: ${sellAmount} ${position.symbol} por $${(sellAmount * sellPrice).toFixed(2)} | Lucro: $${profit.toFixed(2)}`);
      }
      
    } catch (error) {
      this.log(`Erro ao executar venda: ${error.message}`, 'error');
    }
  }

  logCurrentStatus() {
    const now = Date.now();
    if (now - this.lastLogTime < this.config.logFrequency * 1000) {
      return;
    }
    
    this.lastLogTime = now;
    this.logCounter++;
    
    if (this.logCounter % 10 === 0) { // Log detalhado a cada 10 logs
      const status = this.getStatus();
      this.log(`Status: Preço=$${status.currentPrice.toFixed(2)} | Trades=${status.dailyTrades} | Lucro=$${status.totalProfit.toFixed(2)} | Posições=${status.positions.length}`);
    }
  }

  scheduleDailyReset() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    
    this.dailyResetTimeout = setTimeout(() => {
      this.resetDailyStats();
      this.scheduleDailyReset(); // Reagendar para o próximo dia
    }, msUntilMidnight);
  }

  resetDailyStats() {
    this.log('Resetando estatísticas diárias...');
    this.dailyTrades = 0;
    this.dailyLow = Infinity;
    this.dailyHigh = 0;
    
    // Reset no dynamic manager
    if (this.dynamicManager) {
      this.dynamicManager.resetDailyStats();
    }
    
    this.log('Estatísticas diárias resetadas');
  }

  // CORRIGIDO: Status específico do usuário
  getStatus() {
    const currentPrice = this.config.tradingMode === 'dynamic' && this.activeCoin
      ? this.dynamicManager.getCoinState(this.activeCoin)?.currentPrice || 0
      : this.priceHistory.length > 0 
        ? this.priceHistory[this.priceHistory.length - 1].price 
        : 0;
    
    return {
      isRunning: this.isRunning,
      currentPrice: currentPrice,
      dailyLow: this.dailyLow === Infinity ? 0 : this.dailyLow,
      dailyHigh: this.dailyHigh,
      dailyTrades: this.dailyTrades,
      totalProfit: this.totalProfit,
      positions: [], // Será preenchido pela API
      activeCoin: this.activeCoin || '-',
      userId: this.userId
    };
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    
    // Atualizar dynamic manager
    if (this.dynamicManager) {
      this.dynamicManager.updateConfig(this.config);
    }
    
    this.log('Configuração atualizada');
  }

  // Cleanup
  async destroy() {
    await this.stop();
    
    if (this.balanceManager) {
      this.balanceManager.destroy();
    }
    
    if (this.dynamicManager) {
      this.dynamicManager.destroy();
    }
  }
}