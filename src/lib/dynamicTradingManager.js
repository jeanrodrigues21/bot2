import logger from './logger.js';

export default class DynamicTradingManager {
  constructor(config, api, database, userId = null) {
    this.config = config;
    this.api = api;
    this.db = database;
    this.userId = userId; // NOVO: ID do usuário específico
    
    // Estado para múltiplas moedas específico do usuário
    this.coinStates = new Map(); // symbol -> { priceHistory, dailyLow, dailyHigh, lastBuyTime }
    this.activeCoin = null; // Moeda atualmente sendo operada
    
    // Cache de informações dos símbolos
    this.symbolsInfo = new Map();
    
    // Última atualização de dados
    this.lastDataUpdate = 0;
    this.dataUpdateInterval = 30000; // 30 segundos
    
    // NOVO: Prefixo para logs do usuário
    this.logPrefix = userId ? `[User ${userId}]` : '[System]';
  }

  // CORRIGIDO: Log específico do usuário
  log(message, level = 'info') {
    const fullMessage = `${this.logPrefix} DynamicManager: ${message}`;
    
    if (level === 'error') {
      logger.error(fullMessage);
    } else if (level === 'warn') {
      logger.warn(fullMessage);
    } else {
      logger.info(fullMessage);
    }
  }

  // Inicializar estados para todas as moedas dinâmicas
  async initializeCoinStates() {
    try {
      this.log('Inicializando estados para trading dinâmico...');
      
      const coins = this.config.tradingMode === 'dynamic' ? 
        this.config.dynamicCoins : [this.config.symbol];
      
      // Obter informações dos símbolos
      this.symbolsInfo = await this.api.getMultipleSymbolsInfo(coins);
      
      // Inicializar estado para cada moeda
      for (const coin of coins) {
        if (this.symbolsInfo[coin]) {
          this.coinStates.set(coin, {
            priceHistory: [],
            dailyLow: Infinity,
            dailyHigh: 0,
            lastBuyTime: null,
            currentPrice: 0,
            volume24h: 0,
            priceChange24h: 0
          });
        } else {
          this.log(`Símbolo ${coin} não está disponível para trading`, 'warn');
        }
      }
      
      this.log(`Estados inicializados para ${this.coinStates.size} moedas`);
      
      // Carregar dados iniciais
      await this.updateAllCoinData();
      
    } catch (error) {
      this.log(`Erro ao inicializar estados das moedas: ${error.message}`, 'error');
      throw error;
    }
  }

  // Atualizar dados de todas as moedas
  async updateAllCoinData() {
    try {
      const now = Date.now();
      
      // Verificar se é hora de atualizar
      if (now - this.lastDataUpdate < this.dataUpdateInterval) {
        return;
      }
      
      const coins = Array.from(this.coinStates.keys());
      
      // Obter preços atuais
      const prices = await this.api.getMultiplePrices(coins);
      
      // Obter dados de 24h
      const tickers = await this.api.getMultiple24hrTickers(coins);
      
      // Atualizar estado de cada moeda
      for (const coin of coins) {
        const state = this.coinStates.get(coin);
        if (state && prices[coin] && tickers[coin]) {
          const price = prices[coin];
          const ticker = tickers[coin];
          
          // Atualizar preço atual
          state.currentPrice = price;
          state.volume24h = ticker.volume;
          state.priceChange24h = ticker.priceChangePercent;
          
          // Atualizar histórico de preços
          state.priceHistory.push({
            price: price,
            timestamp: new Date()
          });
          
          // Manter apenas os últimos 1000 pontos
          if (state.priceHistory.length > 1000) {
            state.priceHistory.shift();
          }
          
          // Atualizar mínima e máxima diária
          state.dailyLow = Math.min(state.dailyLow, price);
          state.dailyHigh = Math.max(state.dailyHigh, price);
          
          // CORRIGIDO: Salvar no banco específico do usuário
          if (this.db && this.userId) {
            await this.db.saveUserMultiPricePoint(this.userId, coin, {
              price: price,
              dailyLow: ticker.lowPrice,
              dailyHigh: ticker.highPrice,
              volume24h: ticker.volume,
              priceChange24h: ticker.priceChangePercent
            });
          }
        }
      }
      
      this.lastDataUpdate = now;
      
    } catch (error) {
      this.log(`Erro ao atualizar dados das moedas: ${error.message}`, 'error');
    }
  }

  // Encontrar a primeira moeda que atende aos critérios de compra
  findBestCoinToBuy() {
    if (this.config.tradingMode === 'single') {
      // Modo single: usar apenas a moeda configurada
      const state = this.coinStates.get(this.config.symbol);
      if (state && this.shouldBuyCoin(this.config.symbol, state)) {
        return this.config.symbol;
      }
      return null;
    }
    
    // Modo dinâmico: encontrar a primeira moeda que atende aos critérios
    for (const [coin, state] of this.coinStates.entries()) {
      if (this.shouldBuyCoin(coin, state)) {
        this.log(`🎯 Moeda selecionada para compra: ${coin}`);
        return coin;
      }
    }
    
    return null;
  }

  // Verificar se uma moeda específica atende aos critérios de compra
  shouldBuyCoin(symbol, state) {
    try {
      // Verificações básicas
      if (!state || state.priceHistory.length < this.config.minHistoryForAnalysis) {
        return false;
      }
      
      if (state.dailyHigh === state.dailyLow) {
        return false;
      }
      
      // Verificar variação diária mínima
      const dailyVariation = ((state.dailyHigh - state.dailyLow) / state.dailyLow) * 100;
      if (dailyVariation < this.config.minPriceChange) {
        return false;
      }
      
      // Verificar se está próximo da mínima diária
      const priceFromLow = ((state.currentPrice - state.dailyLow) / state.dailyLow) * 100;
      
      if (priceFromLow <= this.config.buyThresholdFromLow) {
        // Verificar tendência de alta recente
        const recentPrices = state.priceHistory
          .slice(-this.config.recentTrendWindow)
          .map(p => p.price);
        
        if (recentPrices.length >= this.config.recentTrendWindow) {
          const halfLength = Math.floor(recentPrices.length / 2);
          const firstHalfAvg = recentPrices.slice(0, halfLength).reduce((a, b) => a + b, 0) / halfLength;
          const secondHalfAvg = recentPrices.slice(halfLength).reduce((a, b) => a + b, 0) / (recentPrices.length - halfLength);
          
          if (secondHalfAvg > firstHalfAvg) {
            // Verificar cooldown
            if (state.lastBuyTime) {
              const timeSinceLastBuy = (Date.now() - state.lastBuyTime.getTime()) / 1000;
              
              if (timeSinceLastBuy < this.config.buyCooldownSeconds) {
                return false;
              }
            }
            
            this.log(`✅ ${symbol} atende aos critérios de compra:`);
            this.log(`  - Preço da mínima: ${priceFromLow.toFixed(2)}% <= ${this.config.buyThresholdFromLow}%`);
            this.log(`  - Tendência de alta: ${firstHalfAvg.toFixed(2)} -> ${secondHalfAvg.toFixed(2)}`);
            this.log(`  - Variação do dia: ${dailyVariation.toFixed(2)}%`);
            this.log(`  - Volume 24h: ${state.volume24h?.toFixed(2) || 'N/A'}`);
            
            return true;
          }
        }
      }
      
      return false;
      
    } catch (error) {
      this.log(`Erro ao verificar critérios de compra para ${symbol}: ${error.message}`, 'error');
      return false;
    }
  }

  // Verificar se deve vender uma posição específica
  shouldSellPosition(position, currentPrice) {
    try {
      const buyPrice = position.buyPrice;
      const symbol = position.symbol;
      
      // Calcular lucro/prejuízo
      const sellAmount = position.quantity;
      const fees = this.calculateFees(buyPrice * position.quantity) + 
                   this.calculateFees(currentPrice * sellAmount);
      const netProfit = (currentPrice * sellAmount) - (buyPrice * position.quantity) - fees;
      const profitPercent = (netProfit / (buyPrice * position.quantity)) * 100;
      
      // Verificar meta de lucro
      if (profitPercent >= this.config.dailyProfitTarget) {
        this.log(`🎯 Meta de lucro atingida para ${symbol}: ${profitPercent.toFixed(2)}% >= ${this.config.dailyProfitTarget}%`);
        return { shouldSell: true, reason: 'profit_target', profitPercent };
      }
      
      // Verificar stop loss
      const lossPercent = ((buyPrice - currentPrice) / buyPrice) * 100;
      if (lossPercent >= this.config.stopLossPercent) {
        this.log(`🛑 Stop loss ativado para ${symbol}! Perda: ${lossPercent.toFixed(2)}%`, 'warn');
        return { shouldSell: true, reason: 'stop_loss', lossPercent };
      }
      
      return { shouldSell: false };
      
    } catch (error) {
      this.log(`Erro ao verificar critérios de venda: ${error.message}`, 'error');
      return { shouldSell: false };
    }
  }

  // Verificar se deve fazer compra de reforço
  shouldReinforcePosition(position, currentPrice) {
    if (!this.config.enableReinforcement) {
      return false;
    }
    
    const buyPrice = position.buyPrice;
    const lossPercent = ((buyPrice - currentPrice) / buyPrice) * 100;
    
    // Verificar se atingiu o trigger de reforço
    if (lossPercent >= this.config.reinforcementTriggerPercent) {
      // CORRIGIDO: Verificar se já existe uma posição de reforço para esta posição específica do usuário
      // (implementar lógica para evitar múltiplos reforços)
      
      this.log(`📈 Trigger de reforço ativado para ${position.symbol}: queda de ${lossPercent.toFixed(2)}%`);
      return true;
    }
    
    return false;
  }

  // Calcular alocação de recursos baseada na estratégia
  calculateAllocation(totalUsdtBalance, strategyType = 'original') {
    const allocation = this.config.calculateAllocation(totalUsdtBalance);
    
    if (strategyType === 'original') {
      return allocation.originalStrategy;
    } else if (strategyType === 'reinforcement') {
      return allocation.reinforcementStrategy;
    }
    
    return 0;
  }

  // Calcular taxas
  calculateFees(amount, isMaker = false) {
    const feeRate = isMaker ? this.config.makerFee : this.config.takerFee;
    return amount * feeRate;
  }

  // Obter estado de uma moeda específica
  getCoinState(symbol) {
    return this.coinStates.get(symbol);
  }

  // Obter todas as moedas monitoradas
  getMonitoredCoins() {
    return Array.from(this.coinStates.keys());
  }

  // Obter estatísticas de todas as moedas
  getAllCoinsStats() {
    const stats = {};
    
    for (const [symbol, state] of this.coinStates.entries()) {
      stats[symbol] = {
        currentPrice: state.currentPrice,
        dailyLow: state.dailyLow === Infinity ? 0 : state.dailyLow,
        dailyHigh: state.dailyHigh,
        volume24h: state.volume24h,
        priceChange24h: state.priceChange24h,
        priceHistoryLength: state.priceHistory.length
      };
    }
    
    return stats;
  }

  // Resetar estatísticas diárias
  resetDailyStats() {
    for (const [symbol, state] of this.coinStates.entries()) {
      state.dailyLow = Infinity;
      state.dailyHigh = 0;
    }
    
    this.log('Estatísticas diárias resetadas para todas as moedas');
  }

  // Atualizar configuração
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.log('Configuração do DynamicTradingManager atualizada');
  }

  // Cleanup
  destroy() {
    this.coinStates.clear();
    this.symbolsInfo.clear();
    this.log('DynamicTradingManager destruído');
  }
}