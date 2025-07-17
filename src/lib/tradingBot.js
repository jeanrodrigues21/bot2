import WebSocket from 'ws';
import BinanceAPI from './binanceApi.js';
import BalanceManager from './balanceManager.js';
import DynamicTradingManager from './dynamicTradingManager.js';
import logger from './logger.js';

export default class TradingBot {
  constructor(config, database, userId = null) {
    this.config = config;
    this.api = new BinanceAPI(config);
    this.db = database;
    this.userId = userId; // NOVO: ID do usuário específico
    this.balanceManager = new BalanceManager(database, this.api, userId);
    
    // NOVO: Gerenciador de trading dinâmico com suporte a usuário
    this.dynamicTradingManager = new DynamicTradingManager(config, this.api, database, userId);
    
    // Estado do bot
    this.currentPrice = 0.0;
    this.dailyLow = Infinity;
    this.dailyHigh = 0.0;
    this.dailyTrades = 0;
    this.positions = [];
    this.totalProfit = 0.0;
    
    // NOVO: Estado para múltiplas moedas com dados completos
    this.activeCoin = null; // Moeda atualmente sendo operada
    this.monitoredCoins = new Map(); // symbol -> { price, change24h, volume, dailyLow, dailyHigh, lastUpdate }
    this.marketData = new Map(); // Cache de dados de mercado para cada moeda
    
    // Reset diário
    this.lastResetDate = new Date().toDateString();
    
    // Histórico de preços
    this.priceHistory = [];
    
    // Controles
    this.lastBuyTime = null;
    this.lastLoggedPrice = null;
    
    // Controle de execução para evitar trades simultâneos
    this.isExecutingTrade = false;
    this.lastTradeTime = 0;
    this.minTimeBetweenTrades = 5000; // 5 segundos mínimo entre trades
    
    // WebSocket
    this.ws = null;
    this.reconnectCount = 0;
    this.isRunning = false;
    
    // Callbacks para comunicação com interface
    this.onStatusUpdate = null;
    this.onLogMessage = null;
    this.onCoinsUpdate = null;
    
    // Intervalos
    this.priceCheckInterval = null;
    this.statsUpdateInterval = null;
    this.stateTimer = null;
    this.coinsUpdateInterval = null;
    this.marketDataInterval = null;

    // Watchdog para detectar WebSocket travado
    this.lastPriceUpdateTime = 0;
    this.watchdogTimer = null;
    this.watchdogInterval = 30000; // 30 segundos sem dados = problema
    this.usingWebSocket = false;
    this.forceRestartWebSocket = false;
  }
  
  log(level, message) {
    const userPrefix = this.userId ? `[User ${this.userId}] ` : '';
    logger[level](`${userPrefix}${message}`);
    if (this.onLogMessage) {
      this.onLogMessage({
        time: new Date().toLocaleTimeString(),
        level,
        message: `${userPrefix}${message}`
      });
    }
  }

  // CORRIGIDO: Obter top 10 moedas da Binance por volume
  async getTop10CoinsByVolume() {
    try {
      const tickers = await this.api.getMultiple24hrTickers([
        'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT',
        'XRPUSDT', 'DOTUSDT', 'DOGEUSDT', 'AVAXUSDT', 'MATICUSDT',
        'LINKUSDT', 'LTCUSDT', 'UNIUSDT', 'ATOMUSDT', 'FILUSDT'
      ]);
      
      // Ordenar por volume e pegar top 10
      const sortedCoins = Object.entries(tickers)
        .sort(([,a], [,b]) => (b.volume || 0) - (a.volume || 0))
        .slice(0, 10)
        .map(([symbol]) => symbol);
      
      this.log('info', `Top 10 moedas por volume: ${sortedCoins.join(', ')}`);
      return sortedCoins;
    } catch (error) {
      this.log('error', `Erro ao obter top 10 moedas: ${error.message}`);
      // Fallback para moedas padrão
      return ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT', 'XRPUSDT', 'DOTUSDT', 'DOGEUSDT', 'AVAXUSDT', 'MATICUSDT'];
    }
  }

  // CORRIGIDO: Calcular dados de máxima e mínima para cada moeda usando dados reais da API
  calculateDailyHighLow(tickerData) {
    // Usar dados reais da API da Binance
    return {
      dailyHigh: parseFloat(tickerData.highPrice || tickerData.h || 0),
      dailyLow: parseFloat(tickerData.lowPrice || tickerData.l || 0)
    };
  }

  // CORRIGIDO: Atualizar dados completos de múltiplas moedas
  async updateMonitoredCoins() {
    try {
      let coinsToMonitor = [];
      
      if (this.config.tradingMode === 'single') {
        // Modo single: apenas a moeda configurada
        coinsToMonitor = [this.config.symbol];
        this.log('debug', `Modo single: monitorando ${this.config.symbol}`);
      } else {
        // Modo dinâmico: top 10 moedas ou configuradas
        if (this.config.dynamicCoins && this.config.dynamicCoins.length > 0) {
          coinsToMonitor = this.config.dynamicCoins;
        } else {
          coinsToMonitor = await this.getTop10CoinsByVolume();
        }
        this.log('info', `Modo dinâmico: monitorando ${coinsToMonitor.length} moedas`);
      }
      
      // Obter dados de múltiplas moedas
      const tickers = await this.api.getMultiple24hrTickers(coinsToMonitor);
      const prices = await this.api.getMultiplePrices(coinsToMonitor);
      
      const updatedCoins = {};
      
      for (const coin of coinsToMonitor) {
        if (tickers[coin] && prices[coin]) {
          const ticker = tickers[coin];
          const currentPrice = prices[coin];
          
          // CORRIGIDO: Usar dados reais da API
          const { dailyHigh, dailyLow } = this.calculateDailyHighLow(ticker);
          
          const coinData = {
            currentPrice: currentPrice,
            priceChange24h: ticker.priceChangePercent,
            volume: ticker.volume,
            dailyHigh: dailyHigh,
            dailyLow: dailyLow,
            highPrice: ticker.highPrice,
            lowPrice: ticker.lowPrice,
            lastUpdate: new Date().toISOString()
          };
          
          this.monitoredCoins.set(coin, coinData);
          updatedCoins[coin] = coinData;
          
          // Se for a moeda ativa, atualizar dados principais
          if (coin === (this.activeCoin || this.config.symbol)) {
            this.currentPrice = currentPrice;
            this.dailyHigh = dailyHigh;
            this.dailyLow = dailyLow;
          }
        }
      }
      
      this.log('debug', `Dados atualizados para ${Object.keys(updatedCoins).length} moedas`);
      
      // CORRIGIDO: Broadcast inteligente baseado no estado
      this.broadcastCoinsData(updatedCoins);
      
    } catch (error) {
      this.log('error', `Erro ao atualizar moedas monitoradas: ${error.message}`);
    }
  }

  // NOVO: Broadcast inteligente de dados das moedas
  broadcastCoinsData(coinsData) {
    if (!this.onCoinsUpdate) return;
    
    let dataToSend = {};
    
    if (this.config.tradingMode === 'single') {
      // Modo single: enviar apenas a moeda configurada
      const symbol = this.config.symbol;
      if (coinsData[symbol]) {
        dataToSend[symbol] = coinsData[symbol];
      }
    } else {
      // Modo dinâmico: comportamento inteligente
      if (this.positions.length > 0 && this.activeCoin) {
        // Há posição ativa: enviar apenas dados da moeda em operação
        if (coinsData[this.activeCoin]) {
          dataToSend[this.activeCoin] = coinsData[this.activeCoin];
        }
        this.log('debug', `Enviando dados focados para: ${this.activeCoin}`);
      } else {
        // Sem posições: enviar todas as 10 moedas
        dataToSend = coinsData;
        this.log('debug', `Enviando dados panorâmicos para ${Object.keys(dataToSend).length} moedas`);
      }
    }
    
    this.onCoinsUpdate({
      type: 'coins_update',
      data: dataToSend
    });
  }

  // NOVO: Encontrar melhor moeda para comprar (modo dinâmico)
  findBestCoinToBuy() {
    if (this.config.tradingMode === 'single') {
      // Modo single: usar apenas a moeda configurada
      if (this.shouldBuy()) {
        this.activeCoin = this.config.symbol;
        return this.config.symbol;
      }
      return null;
    }
    
    // Modo dinâmico: encontrar primeira moeda que atende critérios
    const coins = Array.from(this.monitoredCoins.keys());
    
    for (const coin of coins) {
      const coinData = this.monitoredCoins.get(coin);
      if (coinData && this.shouldBuyCoin(coin, coinData)) {
        this.activeCoin = coin;
        this.log('info', `🎯 Moeda selecionada para compra: ${coin}`);
        return coin;
      }
    }
    
    return null;
  }

  // NOVO: Verificar se deve comprar uma moeda específica
  shouldBuyCoin(symbol, coinData) {
    try {
      // Verificações básicas
      if (this.dailyTrades >= this.config.maxDailyTrades) {
        return false;
      }
      
      if (this.positions.length > 0) {
        return false;
      }
      
      // Verificar variação diária mínima
      const priceChange24h = Math.abs(coinData.priceChange24h);
      if (priceChange24h < this.config.minPriceChange) {
        return false;
      }
      
      // Verificar se a moeda está em queda (oportunidade de compra)
      if (coinData.priceChange24h > -0.5) { // Não está em queda suficiente
        return false;
      }
      
      // Verificar volume mínimo
      if (coinData.volume < 1000000) { // Volume muito baixo
        return false;
      }
      
      // Verificar se está próximo da mínima
      const priceFromLow = ((coinData.currentPrice - coinData.dailyLow) / coinData.dailyLow) * 100;
      if (priceFromLow > this.config.buyThresholdFromLow) {
        return false;
      }
      
      this.log('info', `✅ ${symbol} atende aos critérios de compra:`);
      this.log('info', `  - Variação 24h: ${coinData.priceChange24h.toFixed(2)}%`);
      this.log('info', `  - Volume 24h: ${coinData.volume.toFixed(2)}`);
      this.log('info', `  - Preço atual: $${coinData.currentPrice.toFixed(2)}`);
      this.log('info', `  - Distância da mínima: ${priceFromLow.toFixed(2)}%`);
      
      return true;
      
    } catch (error) {
      this.log('error', `Erro ao verificar critérios de compra para ${symbol}:`, error);
      return false;
    }
  }

  async validateStateIntegrity() {
    if (!this.db) return true;
    
    try {
      // CORRIGIDO: Usar métodos específicos do usuário
      const positions = this.userId ? 
        await this.db.getUserOpenPositions(this.userId) : 
        await this.db.getOpenPositions();
      
      const validPositions = [];
      
      for (const position of positions) {
        // Verificar se a posição não é muito antiga (mais de 24h)
        const positionDate = new Date(position.timestamp);
        const now = new Date();
        const hoursDiff = (now - positionDate) / (1000 * 60 * 60);
        
        if (hoursDiff > 2000000000000) {
          this.log('warn', `Posição muito antiga encontrada (${hoursDiff.toFixed(1)}h): ${position.orderId}`);
          continue;
        }
        
        validPositions.push(position);
      }
      
      // Atualizar posições válidas
      this.positions = validPositions;
      
      // Definir moeda ativa baseada nas posições
      if (validPositions.length > 0) {
        this.activeCoin = validPositions[0].symbol || this.config.symbol;
      } else {
        this.activeCoin = null;
      }
      
      this.log('info', `Validação de integridade concluída. Posições válidas: ${validPositions.length}`);
      return true;
      
    } catch (error) {
      this.log('error', `Erro na validação de integridade: ${error.message}`);
      return false;
    }
  }

  async startPeriodicStateSave() {
    // Salvar estado a cada 5 minutos para garantir persistência
    this.stateTimer = setInterval(async () => {
      if (this.isRunning && this.db) {
        try {
          // CORRIGIDO: Usar métodos específicos do usuário
          if (this.userId) {
            await this.db.saveUserBotState(this.userId, this.totalProfit, this.dailyTrades);
          } else {
            await this.db.saveBotState(this.totalProfit, this.dailyTrades);
          }
          this.log('debug', 'Estado do bot salvo automaticamente');
        } catch (error) {
          this.log('error', `Erro ao salvar estado automaticamente: ${error.message}`);
        }
      }
    }, 5 * 60 * 1000); // 5 minutos
  }

  async stopPeriodicStateSave() {
    if (this.stateTimer) {
      clearInterval(this.stateTimer);
      this.stateTimer = null;
    }
  }

  // CORRIGIDO: Iniciar atualização de moedas monitoradas
  startCoinsUpdate() {
    // Atualizar dados das moedas a cada 30 segundos
    this.coinsUpdateInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.updateMonitoredCoins();
      }
    }, 30000);
    
    // Primeira atualização imediata
    this.updateMonitoredCoins();
  }

  stopCoinsUpdate() {
    if (this.coinsUpdateInterval) {
      clearInterval(this.coinsUpdateInterval);
      this.coinsUpdateInterval = null;
    }
  }

  // CORRIGIDO: Iniciar atualização de dados de mercado
  startMarketDataUpdate() {
    // Atualizar dados de mercado a cada 10 segundos para maior precisão
    this.marketDataInterval = setInterval(async () => {
      if (this.isRunning) {
        await this.updateMarketData();
      }
    }, 10000);
  }

  stopMarketDataUpdate() {
    if (this.marketDataInterval) {
      clearInterval(this.marketDataInterval);
      this.marketDataInterval = null;
    }
  }

  // NOVO: Atualizar dados de mercado em tempo real
  async updateMarketData() {
    try {
      // Atualizar apenas as moedas que estão sendo monitoradas
      const coinsToUpdate = Array.from(this.monitoredCoins.keys());
      
      if (coinsToUpdate.length === 0) return;
      
      const prices = await this.api.getMultiplePrices(coinsToUpdate);
      
      for (const [symbol, coinData] of this.monitoredCoins.entries()) {
        if (prices[symbol]) {
          const newPrice = prices[symbol];
          
          // Atualizar preço atual
          coinData.currentPrice = newPrice;
          
          // Atualizar máxima e mínima do dia
          coinData.dailyHigh = Math.max(coinData.dailyHigh, newPrice);
          coinData.dailyLow = Math.min(coinData.dailyLow, newPrice);
          coinData.lastUpdate = new Date().toISOString();
          
          // Se for a moeda ativa, atualizar dados principais
          if (symbol === this.activeCoin) {
            this.currentPrice = newPrice;
            this.dailyHigh = coinData.dailyHigh;
            this.dailyLow = coinData.dailyLow;
          }
        }
      }
      
      // Broadcast dos dados atualizados
      const updatedData = {};
      for (const [symbol, data] of this.monitoredCoins.entries()) {
        updatedData[symbol] = data;
      }
      
      this.broadcastCoinsData(updatedData);
      
    } catch (error) {
      this.log('error', `Erro ao atualizar dados de mercado: ${error.message}`);
    }
  }

  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    this.api = new BinanceAPI(this.config);
    this.balanceManager = new BalanceManager(this.db, this.api, this.userId);
    this.dynamicTradingManager.updateConfig(this.config);
    this.log('info', 'Configuração do bot atualizada em tempo de execução');
    
    // Reiniciar monitoramento de moedas se mudou o modo
    if (this.isRunning) {
      this.stopCoinsUpdate();
      this.stopMarketDataUpdate();
      this.startCoinsUpdate();
      this.startMarketDataUpdate();
    }
  }
  
  updateStatus() {
    if (this.onStatusUpdate) {
      this.onStatusUpdate({
        isRunning: this.isRunning,
        currentPrice: this.currentPrice,
        dailyLow: this.dailyLow === Infinity ? 0 : this.dailyLow,
        dailyHigh: this.dailyHigh,
        dailyTrades: this.dailyTrades,
        totalProfit: this.totalProfit,
        positions: this.positions,
        activeCoin: this.activeCoin || '-',
        testMode: false // Sempre produção
      });
    }
  }
  
  async resetDailyStats() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.log('info', `Resetando estatísticas diárias. Trades realizados ontem: ${this.dailyTrades}`);
      this.log('info', `Lucro total de ontem: $ ${this.totalProfit.toFixed(2)}`);
      
      // Salvar estatísticas do dia anterior
      if (this.db) {
        await this.db.saveDailyStats(
          this.lastResetDate,
          this.activeCoin || this.config.symbol,
          this.dailyTrades,
          this.totalProfit,
          this.dailyLow === Infinity ? 0 : this.dailyLow,
          this.dailyHigh
        );
        
        // CORRIGIDO: Usar métodos específicos do usuário
        if (this.userId) {
          await this.db.resetUserDailyStats(this.userId);
        } else {
          await this.db.resetDailyStats();
        }
      }
      
      // Resetar dados de todas as moedas monitoradas
      for (const [symbol, coinData] of this.monitoredCoins.entries()) {
        coinData.dailyHigh = coinData.currentPrice;
        coinData.dailyLow = coinData.currentPrice;
      }
      
      this.dailyLow = Infinity;
      this.dailyHigh = 0.0;
      this.dailyTrades = 0;
      this.lastResetDate = today;
      this.updateStatus();
    }
  }
  
  async updatePriceStats(price, symbol = null) {
    const currentSymbol = symbol || this.activeCoin || this.config.symbol;
    
    // Atualizar apenas se for a moeda ativa
    if (currentSymbol === (this.activeCoin || this.config.symbol)) {
      this.currentPrice = price;
      this.dailyLow = Math.min(this.dailyLow, price);
      this.dailyHigh = Math.max(this.dailyHigh, price);
      
      this.priceHistory.push({
        price: price,
        timestamp: new Date(),
        symbol: currentSymbol
      });
      
      if (this.priceHistory.length > this.config.maxHistorySize) {
        this.priceHistory.shift();
      }
      
      // Salvar ponto de preço no banco de dados (a cada 10 pontos para não sobrecarregar)
      if (this.db && this.priceHistory.length % 10 === 0) {
        await this.db.savePricePoint(currentSymbol, price);
      }
    }
    
    this.updateStatus();
  }
  
  calculateFees(amount, isMaker = false) {
    const feeRate = isMaker ? this.config.makerFee : this.config.takerFee;
    return amount * feeRate;
  }

  // NOVO: Calcular valor de trade baseado na porcentagem do saldo
  async calculateTradeAmount() {
    try {
      // Obter saldo real da API
      const usdtBalance = await this.api.getUsdtBalance();
      
      if (usdtBalance <= 0) {
        this.log('warn', 'Saldo USDT insuficiente para calcular valor de trade');
        return this.config.minTradeAmountUsdt || 5;
      }
      
      // Usar o método da configuração para calcular
      const tradeAmount = this.config.calculateTradeAmount(usdtBalance);
      
      this.log('info', `💰 Cálculo de trade:`);
      this.log('info', `  - Saldo total: $${usdtBalance.toFixed(2)}`);
      this.log('info', `  - Porcentagem: ${this.config.tradeAmountPercent}%`);
      this.log('info', `  - Valor calculado: $${tradeAmount.toFixed(2)}`);
      this.log('info', `  - Limites: Min $${this.config.minTradeAmountUsdt} | Max $${this.config.maxTradeAmountUsdt}`);
      
      return tradeAmount;
      
    } catch (error) {
      this.log('error', `Erro ao calcular valor de trade: ${error.message}`);
      // Fallback para valor mínimo
      return this.config.minTradeAmountUsdt || 5;
    }
  }
  
  shouldBuy() {
    // Verificar se já está executando um trade
    if (this.isExecutingTrade) {
      this.log('debug', 'Trade já em execução, pulando verificação de compra');
      return false;
    }
    
    // Verificar tempo mínimo entre trades
    const now = Date.now();
    if (now - this.lastTradeTime < this.minTimeBetweenTrades) {
      this.log('debug', `Aguardando intervalo mínimo entre trades (${this.minTimeBetweenTrades/1000}s)`);
      return false;
    }
    
    if (this.dailyTrades >= this.config.maxDailyTrades) {
      return false;
    }
    
    if (this.priceHistory.length < this.config.minHistoryForAnalysis) {
      return false;
    }
    
    if (this.positions.length > 0) {
      return false;
    }
    
    if (this.dailyHigh === this.dailyLow) {
      return false;
    }
    
    const dailyVariation = ((this.dailyHigh - this.dailyLow) / this.dailyLow) * 100;
    if (dailyVariation < this.config.minPriceChange) {
      return false;
    }
    
    const priceFromLow = ((this.currentPrice - this.dailyLow) / this.dailyLow) * 100;
    
    if (priceFromLow <= this.config.buyThresholdFromLow) {
      const recentPrices = this.priceHistory
        .slice(-this.config.recentTrendWindow)
        .map(p => p.price);
      
      if (recentPrices.length >= this.config.recentTrendWindow) {
        const halfLength = Math.floor(recentPrices.length / 2);
        const firstHalfAvg = recentPrices.slice(0, halfLength).reduce((a, b) => a + b, 0) / halfLength;
        const secondHalfAvg = recentPrices.slice(halfLength).reduce((a, b) => a + b, 0) / (recentPrices.length - halfLength);
        
        if (secondHalfAvg > firstHalfAvg) {
          if (this.lastBuyTime) {
            const timeSinceLastBuy = (Date.now() - this.lastBuyTime.getTime()) / 1000;
            
            if (timeSinceLastBuy < this.config.buyCooldownSeconds) {
              return false;
            }
          }
          
          this.log('info', `Condições de compra atendidas:`);
          this.log('info', `  - Preço da mínima: ${priceFromLow.toFixed(2)}% <= ${this.config.buyThresholdFromLow}%`);
          this.log('info', `  - Tendência de alta confirmada: ${firstHalfAvg.toFixed(2)} -> ${secondHalfAvg.toFixed(2)}`);
          this.log('info', `  - Variação do dia: ${dailyVariation.toFixed(2)}%`);
          return true;
        }
      }
    }
    
    return false;
  }
  
  // CORRIGIDO: Função shouldSell com validação robusta e cálculo correto do tradeAmount
  shouldSell(buyPrice = null) {
    try {
      // Verificação básica de posições
      if (!this.positions || this.positions.length === 0) {
        return false;
      }

      const position = this.positions[0];
      
      // CORREÇÃO PRINCIPAL: Validação robusta dos dados da posição
      if (!position || 
          typeof position.buyPrice !== 'number' || 
          typeof position.quantity !== 'number' ||
          isNaN(position.buyPrice) || 
          isNaN(position.quantity) ||
          position.buyPrice <= 0 || 
          position.quantity <= 0) {
        this.log('warn', 'Dados da posição inválidos para cálculo de venda');
        this.log('debug', 'Dados da posição:', JSON.stringify(position, null, 2));
        return false;
      }

      // Verificar se temos preço atual válido
      if (typeof this.currentPrice !== 'number' || isNaN(this.currentPrice) || this.currentPrice <= 0) {
        this.log('warn', 'Preço atual inválido para cálculo de venda');
        return false;
      }

      // CORREÇÃO PRINCIPAL: Calcular tradeAmount corretamente
      let tradeAmount;
      
      // Se a posição já tem tradeAmount salvo, usar ele
      if (position.tradeAmount && typeof position.tradeAmount === 'number' && position.tradeAmount > 0) {
        tradeAmount = position.tradeAmount;
        this.log('info', `TradeAmount da posição: $${tradeAmount.toFixed(2)}`);
      } else {
        // Calcular baseado no preço de compra e quantidade
        tradeAmount = position.buyPrice * position.quantity;
        this.log('info', `TradeAmount calculado automaticamente: $${tradeAmount.toFixed(2)} (${position.buyPrice} × ${position.quantity})`);
      }
      
      // Verificar se o tradeAmount calculado é válido
      if (typeof tradeAmount !== 'number' || isNaN(tradeAmount) || tradeAmount <= 0) {
        this.log('warn', 'TradeAmount inválido para cálculo de venda');
        return false;
      }

      // Usar dados da posição para cálculos
      const positionBuyPrice = position.buyPrice;
      const quantity = position.quantity;
      
      // Calcular valores
      const buyValue = tradeAmount; // Valor já gasto na compra
      const sellValue = this.currentPrice * quantity; // Valor que receberemos na venda
      const buyFee = this.calculateFees(buyValue);
      const sellFee = this.calculateFees(sellValue);
      const totalFees = buyFee + sellFee;
      const netProfit = sellValue - buyValue - totalFees;
      const profitPercent = (netProfit / buyValue) * 100;

      // Log detalhado para debug
      this.log('info', '📊 Análise de venda:');
      this.log('info', `  - Preço de compra: $${positionBuyPrice.toFixed(2)}`);
      this.log('info', `  - Preço atual: $${this.currentPrice.toFixed(2)}`);
      this.log('info', `  - Quantidade: ${quantity.toFixed(8)}`);
      this.log('info', `  - Valor de compra: $${buyValue.toFixed(2)}`);
      this.log('info', `  - Valor de venda: $${sellValue.toFixed(2)}`);
      this.log('info', `  - Taxas totais: $${totalFees.toFixed(2)}`);
      this.log('info', `  - Lucro líquido: $${netProfit.toFixed(2)}`);
      this.log('info', `  - Lucro %: ${profitPercent.toFixed(2)}%`);
      this.log('info', `  - Meta: ${this.config.dailyProfitTarget}%`);

      // Verificar meta de lucro
      if (profitPercent >= this.config.dailyProfitTarget) {
        this.log('info', `🎯 META DE LUCRO ATINGIDA: ${profitPercent.toFixed(2)}% >= ${this.config.dailyProfitTarget}%`);
        return true;
      }

      // Verificar stop loss
      const lossPercent = ((positionBuyPrice - this.currentPrice) / positionBuyPrice) * 100;
      if (lossPercent >= this.config.stopLossPercent) {
        this.log('warn', `🛑 STOP LOSS ATIVADO: Perda de ${lossPercent.toFixed(2)}% >= ${this.config.stopLossPercent}%`);
        return true;
      }

      return false;

    } catch (error) {
      this.log('error', `Erro na função shouldSell: ${error.message}`);
      return false;
    }
  }

  async executeBuy(symbol = null) {
    // Verificar se já está executando um trade
    if (this.isExecutingTrade) {
      this.log('warn', "Trade já em execução - cancelando nova tentativa");
      return;
    }
    
    // Marcar como executando trade
    this.isExecutingTrade = true;
    this.lastTradeTime = Date.now();
    
    try {
      if (this.positions.length > 0) {
        this.log('warn', "Tentativa de compra com posição já aberta - cancelando");
        return;
      }
      
      // Determinar símbolo a ser usado
      const targetSymbol = symbol || this.activeCoin || this.config.symbol;
      
      // NOVO: Calcular valor de trade baseado na porcentagem do saldo
      const tradeAmount = await this.calculateTradeAmount();
      
      if (tradeAmount < 5) {
        this.log('warn', `Valor de trade muito baixo: $${tradeAmount.toFixed(2)}`);
        return;
      }
      
      // Obter preço atual da moeda específica
      const currentPrice = await this.api.getCurrentPrice(targetSymbol);
      let quantity = tradeAmount / currentPrice;
      
      this.log('info', `Executando compra de ${targetSymbol} com $${tradeAmount.toFixed(2)} (${this.config.tradeAmountPercent}% do saldo)`);
      
      // Executar ordem real
      const order = await this.api.placeOrder('BUY', quantity, null, 'MARKET', targetSymbol);
      
      if (!order || order.status !== 'FILLED') {
        this.log('error', `Ordem não foi executada corretamente: ${JSON.stringify(order)}`);
        return;
      }
      
      // Aguardar um momento para a ordem ser processada
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Verificar saldos reais após a compra
      const newUsdtBalance = await this.api.getUsdtBalance();
      const newAssetBalance = await this.api.getBaseAssetBalance(targetSymbol);
      
      // Atualizar saldos no banco
      await this.balanceManager.updateProductionBalance();
      
      // Usar a quantidade real executada
      quantity = parseFloat(order.executedQty || order.quantity);
      const actualTradeAmount = parseFloat(order.cummulativeQuoteQty || tradeAmount);
      
      this.log('info', `✅ COMPRA REAL executada: ${quantity.toFixed(8)} ${targetSymbol.replace('USDT', '')} por $ ${actualTradeAmount.toFixed(2)}`);
      this.log('info', `Novos saldos - USDT: ${newUsdtBalance.toFixed(2)}, ${targetSymbol.replace('USDT', '')}: ${newAssetBalance.toFixed(8)}`);
      
      if (order?.orderId) {
        const position = {
          buyPrice: currentPrice,
          quantity: quantity,
          timestamp: new Date().toISOString(),
          orderId: order.orderId,
          symbol: targetSymbol,
          tradeAmount: actualTradeAmount, // IMPORTANTE: Salvar o valor real gasto
          strategyType: 'original'
        };
        
        this.positions.push(position);
        this.dailyTrades++;
        this.lastBuyTime = new Date();
        this.activeCoin = targetSymbol;
        
        // CORRIGIDO: Salvar no banco de dados usando métodos específicos do usuário
        if (this.db) {
          if (this.userId) {
            await this.db.saveUserPosition(this.userId, {
              ...position,
              symbol: targetSymbol
            });
            await this.db.saveUserTrade(this.userId, {
              orderId: order.orderId,
              symbol: targetSymbol,
              side: 'BUY',
              quantity: quantity,
              price: currentPrice,
              fee: this.calculateFees(actualTradeAmount),
              strategyType: 'original'
            });
            await this.db.saveUserBotState(this.userId, this.totalProfit, this.dailyTrades);
          } else {
            await this.db.savePosition({
              ...position,
              symbol: targetSymbol
            });
            await this.db.saveTrade({
              orderId: order.orderId,
              symbol: targetSymbol,
              side: 'BUY',
              quantity: quantity,
              price: currentPrice,
              fee: this.calculateFees(actualTradeAmount),
              strategyType: 'original'
            });
            await this.db.saveBotState(this.totalProfit, this.dailyTrades);
          }
        }
        
        this.log('info', `✅ POSIÇÃO CRIADA: ${quantity.toFixed(8)} ${targetSymbol.replace('USDT', '')} comprado por $ ${currentPrice.toFixed(2)}`);
        
        // IMPORTANTE: Atualizar broadcast para modo focado
        this.updateStatus();
        await this.updateMonitoredCoins(); // Forçar atualização para mudar para modo focado
      }
      
    } catch (error) {
      this.log('error', `Erro ao executar compra: ${error.message}`);
    } finally {
      // Sempre liberar o lock de execução
      this.isExecutingTrade = false;
    }
  }
  
  async executeSell(position) {
    // Verificar se já está executando um trade
    if (this.isExecutingTrade) {
      this.log('warn', "Trade já em execução - cancelando venda");
      return;
    }
    
    // Marcar como executando trade
    this.isExecutingTrade = true;
    this.lastTradeTime = Date.now();
    
    try {
      const targetSymbol = position.symbol || this.config.symbol;
      
      // CORREÇÃO PRINCIPAL: Verificar saldo real do ativo antes da venda
      let assetBalance = await this.api.getBaseAssetBalance(targetSymbol);
      
      this.log('info', `Saldo real de ${targetSymbol.replace('USDT', '')}: ${assetBalance.toFixed(8)}`);
      this.log('info', `Quantidade da posição: ${position.quantity.toFixed(8)}`);
      
      // Verificar se temos saldo suficiente
      if (assetBalance < position.quantity * 0.99) {
        this.log('warn', `Saldo ${targetSymbol.replace('USDT', '')} insuficiente para venda. Disponível: ${assetBalance.toFixed(8)}, Necessário: ${position.quantity.toFixed(8)}`);
        
        // Se o saldo for muito baixo, usar o que temos disponível
        if (assetBalance > 0) {
          assetBalance = assetBalance * 0.99; // 99% para margem de segurança
          this.log('info', `Usando saldo disponível: ${assetBalance.toFixed(8)}`);
        } else {
          this.log('error', 'Saldo insuficiente para executar venda');
          return;
        }
      } else {
        assetBalance = position.quantity;
      }
      
      // Verificar valor mínimo da ordem
      const currentPrice = await this.api.getCurrentPrice(targetSymbol);
      const orderValue = assetBalance * currentPrice;
      
      if (orderValue < 5) {
        this.log('warn', `Valor da ordem muito baixo: $${orderValue.toFixed(2)} - cancelando venda`);
        return;
      }
      
      this.log('info', `Executando venda: ${assetBalance.toFixed(8)} ${targetSymbol.replace('USDT', '')} (valor estimado: $${orderValue.toFixed(2)})`);
      
      // Executar ordem real
      const order = await this.api.placeOrder('SELL', assetBalance, null, 'MARKET', targetSymbol);
      
      if (!order || order.status !== 'FILLED') {
        this.log('error', `Ordem de venda não foi executada corretamente: ${JSON.stringify(order)}`);
        return;
      }
      
      // Aguardar um momento para a ordem ser processada
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Verificar saldos reais após a venda
      const newUsdtBalance = await this.api.getUsdtBalance();
      const newAssetBalance = await this.api.getBaseAssetBalance(targetSymbol);
      
      // Atualizar saldos no banco
      await this.balanceManager.updateProductionBalance();
      
      const actualSellValue = parseFloat(order.cummulativeQuoteQty);
      
      this.log('info', `✅ VENDA REAL executada: ${assetBalance.toFixed(8)} ${targetSymbol.replace('USDT', '')} por $ ${actualSellValue.toFixed(2)}`);
      this.log('info', `Novos saldos - USDT: ${newUsdtBalance.toFixed(2)}, ${targetSymbol.replace('USDT', '')}: ${newAssetBalance.toFixed(8)}`);
      
      if (order?.orderId) {
        const sellValue = parseFloat(order.cummulativeQuoteQty || (this.currentPrice * assetBalance));
        
        // CORREÇÃO: Usar o tradeAmount correto da posição
        let buyValue;
        if (position.tradeAmount && position.tradeAmount > 0) {
          buyValue = position.tradeAmount;
        } else {
          buyValue = position.buyPrice * position.quantity;
        }
        
        const fees = this.calculateFees(buyValue) + this.calculateFees(sellValue);
        const profit = sellValue - buyValue - fees;
        
        this.totalProfit += profit;
        this.positions = this.positions.filter(p => p.orderId !== position.orderId);
        this.dailyTrades++;
        
        // IMPORTANTE: Limpar moeda ativa quando não há mais posições
        if (this.positions.length === 0) {
          this.activeCoin = null;
        }
        
        // CORRIGIDO: Salvar no banco de dados usando métodos específicos do usuário
        if (this.db) {
          if (this.userId) {
            await this.db.closeUserPosition(this.userId, position.orderId, this.currentPrice, profit);
            await this.db.saveUserBotState(this.userId, this.totalProfit, this.dailyTrades);
          } else {
            await this.db.closePosition(position.orderId, this.currentPrice, profit);
            await this.db.saveBotState(this.totalProfit, this.dailyTrades);
          }
        }
        
        this.log('info', `✅ POSIÇÃO FECHADA: Lucro: $ ${profit.toFixed(2)} | Lucro total: $ ${this.totalProfit.toFixed(2)}`);
        
        // IMPORTANTE: Atualizar broadcast para voltar ao modo panorâmico
        this.updateStatus();
        await this.updateMonitoredCoins(); // Forçar atualização para voltar ao modo panorâmico
      }
      
    } catch (error) {
      this.log('error', `Erro ao executar venda: ${error.message}`);
    } finally {
      // Sempre liberar o lock de execução
      this.isExecutingTrade = false;
    }
  }
  
  // CORRIGIDO: Função processPriceUpdate com lógica de venda corrigida
  async processPriceUpdate(price, symbol = null) {
    await this.resetDailyStats();
    
    const currentSymbol = symbol || this.activeCoin || this.config.symbol;
    
    if (this.lastLoggedPrice) {
      const priceChange = Math.abs(price - this.lastLoggedPrice) / this.lastLoggedPrice * 100;
      
      if (priceChange < this.config.minPriceChangeLog) {
        return;
      }
    }
    
    await this.updatePriceStats(price, currentSymbol);
    this.lastLoggedPrice = price;
    
    if (this.priceHistory.length % this.config.logFrequency === 0) {
      const dailyVariation = this.dailyLow > 0 ? 
        ((this.dailyHigh - this.dailyLow) / this.dailyLow) * 100 : 0;
      this.log('info', `${currentSymbol} - Preço: $ ${price.toFixed(2)} | Min: $ ${this.dailyLow.toFixed(2)} | Max: $ ${this.dailyHigh.toFixed(2)} | Var: ${dailyVariation.toFixed(2)}% | Trades: ${this.dailyTrades}`);
    }
    
    // CORRIGIDO: Lógica de venda ANTES da lógica de compra
    if (this.positions.length > 0) {
      for (const position of [...this.positions]) {
        if (this.shouldSell()) {
          this.log('info', '🚀 EXECUTANDO VENDA - Meta de lucro atingida!');
          await this.executeSell(position);
          break; // Sair do loop após executar uma venda
        }
      }
    }
    
    // Lógica de compra (só executa se não há posições abertas)
    if (this.positions.length === 0) {
      const bestCoin = this.findBestCoinToBuy();
      if (bestCoin) {
        await this.executeBuy(bestCoin);
      }
    }
  }

  startPriceMonitoring() {
    // Tentar WebSocket primeiro, depois fallback para polling
    this.websocketHandler().catch(() => {
      this.log('warn', 'WebSocket falhou, usando polling de preços');
      this.fallbackPriceMonitor();
    });
  }

  async fallbackPriceMonitor() {
    // Só usar fallback se não estiver usando WebSocket
    if (this.usingWebSocket) {
      return;
    }
    
    const interval = this.config.pricePollInterval * 1000;
    
    this.log('info', `Iniciando monitor de preços via API REST (intervalo: ${this.config.pricePollInterval}s)`);
    
    this.priceCheckInterval = setInterval(async () => {
      if (!this.isRunning || this.usingWebSocket) {
        clearInterval(this.priceCheckInterval);
        return;
      }
      
      try {
        // Atualizar dados de múltiplas moedas
        await this.updateMonitoredCoins();
        
        // Obter preço da moeda ativa ou configurada
        const targetSymbol = this.activeCoin || this.config.symbol;
        const price = await this.api.getCurrentPrice(targetSymbol);
        
        if (price > 0) {
          this.lastPriceUpdateTime = Date.now();
          await this.processPriceUpdate(price, targetSymbol);
        } else {
          this.log('warn', "Preço inválido recebido da API");
        }
      } catch (error) {
        this.log('error', `Erro no monitor de preços: ${error.message}`);
      }
    }, interval);
  }
  
  async checkSymbolAvailability() {
    try {
      if (this.config.tradingMode === 'single') {
        const symbolInfo = await this.api.getSymbolInfo(this.config.symbol);
        
        if (symbolInfo) {
          this.log('info', `Símbolo ${this.config.symbol} está disponível`);
          return true;
        } else {
          this.log('warn', `Símbolo ${this.config.symbol} NÃO está disponível`);
          return false;
        }
      } else {
        // Modo dinâmico: verificar múltiplos símbolos
        const coins = this.config.dynamicCoins || await this.getTop10CoinsByVolume();
        const symbolsInfo = await this.api.getMultipleSymbolsInfo(coins);
        
        const availableCoins = Object.keys(symbolsInfo);
        this.log('info', `${availableCoins.length}/${coins.length} símbolos disponíveis: ${availableCoins.join(', ')}`);
        
        return availableCoins.length > 0;
      }
    } catch (error) {
      this.log('error', `Erro ao verificar símbolos disponíveis: ${error.message}`);
      return false;
    }
  }
  
  async websocketHandler() {
    if (!(await this.checkSymbolAvailability())) {
      throw new Error("Símbolos indisponíveis");
    }
    
    // Para modo dinâmico, usar WebSocket de múltiplos streams
    let uri;
    
    if (this.config.tradingMode === 'dynamic') {
      const coins = this.config.dynamicCoins || await this.getTop10CoinsByVolume();
      const streams = coins.map(coin => `${coin.toLowerCase()}@ticker`).join('/');
      uri = `${this.config.wsUrl}/stream?streams=${streams}`;
    } else {
      const symbolLower = this.config.symbol.toLowerCase();
      uri = `${this.config.wsUrl}/ws/${symbolLower}@ticker`;
    }
    
    this.log('info', `Conectando ao WebSocket: ${uri}`);
    this.usingWebSocket = true;
    
    this.ws = new WebSocket(uri);
    
    this.ws.on('open', () => {
      this.log('info', 'WebSocket conectado com sucesso');
      this.reconnectCount = 0;
      this.lastPriceUpdateTime = Date.now();
      this.startWatchdog();
    });
    
    this.ws.on('message', async (data) => {
      try {
        const json = JSON.parse(data.toString());
        
        // Processar dados baseado no modo
        if (this.config.tradingMode === 'dynamic') {
          // Modo dinâmico: múltiplos streams
          if (json.stream && json.data) {
            const symbol = json.stream.replace('@ticker', '').toUpperCase();
            const tickerData = json.data;
            
            if (tickerData.c && !isNaN(parseFloat(tickerData.c))) {
              const price = parseFloat(tickerData.c);
              const priceChange24h = parseFloat(tickerData.P || 0);
              const volume = parseFloat(tickerData.v || 0);
              
              // CORRIGIDO: Usar dados reais da API
              const { dailyHigh, dailyLow } = this.calculateDailyHighLow(tickerData);
              
              // Atualizar dados da moeda
              this.monitoredCoins.set(symbol, {
                currentPrice: price,
                priceChange24h: priceChange24h,
                volume: volume,
                dailyHigh: dailyHigh,
                dailyLow: dailyLow,
                highPrice: parseFloat(tickerData.h || price),
                lowPrice: parseFloat(tickerData.l || price),
                lastUpdate: new Date().toISOString()
              });
              
              // Se for a moeda ativa, processar atualização de preço
              if (symbol === this.activeCoin) {
                this.lastPriceUpdateTime = Date.now();
                await this.processPriceUpdate(price, symbol);
              }
              
              // Broadcast dos dados atualizados
              const updatedData = {};
              for (const [sym, data] of this.monitoredCoins.entries()) {
                updatedData[sym] = data;
              }
              this.broadcastCoinsData(updatedData);
            }
          }
        } else {
          // Modo single: stream único
          if (json.c && !isNaN(parseFloat(json.c))) {
            const price = parseFloat(json.c);
            const priceChange24h = parseFloat(json.P || 0);
            const volume = parseFloat(json.v || 0);
            
            // CORRIGIDO: Usar dados reais da API
            const { dailyHigh, dailyLow } = this.calculateDailyHighLow(json);
            
            this.monitoredCoins.set(this.config.symbol, {
              currentPrice: price,
              priceChange24h: priceChange24h,
              volume: volume,
              dailyHigh: dailyHigh,
              dailyLow: dailyLow,
              highPrice: parseFloat(json.h || price),
              lowPrice: parseFloat(json.l || price),
              lastUpdate: new Date().toISOString()
            });
            
            this.lastPriceUpdateTime = Date.now();
            await this.processPriceUpdate(price);
            
            // Broadcast dos dados
            const updatedData = {};
            updatedData[this.config.symbol] = this.monitoredCoins.get(this.config.symbol);
            this.broadcastCoinsData(updatedData);
          }
        }
      } catch (error) {
        this.log('error', `Erro ao processar mensagem WebSocket: ${error.message}`);
      }
    });
    
    this.ws.on('error', (error) => {
      this.log('error', `Erro no WebSocket: ${error.message}`);
      this.stopWatchdog();
    });
    
    this.ws.on('close', (code, reason) => {
      this.log('warn', `WebSocket fechado: ${code} - ${reason}`);
      this.stopWatchdog();
      this.usingWebSocket = false;
      
      if (this.isRunning && !this.forceRestartWebSocket) {
        this.reconnectWebSocket();
      }
    });
    
    // Implementar ping/pong para detectar conexões mortas
    this.ws.on('pong', () => {
      this.log('debug', 'Pong recebido do WebSocket');
    });
    
    // Enviar ping periodicamente
    const pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 20000); // Ping a cada 20 segundos
  }

  startWatchdog() {
    this.stopWatchdog(); // Limpar timer anterior se existir
    
    this.watchdogTimer = setInterval(() => {
      const timeSinceLastUpdate = Date.now() - this.lastPriceUpdateTime;
      
      if (timeSinceLastUpdate > this.watchdogInterval) {
        this.log('error', `🚨 WATCHDOG: WebSocket travado! Sem dados há ${Math.round(timeSinceLastUpdate/1000)}s`);
        this.log('info', 'Forçando reconexão do WebSocket...');
        
        // Forçar fechamento e reconexão
        this.forceRestartWebSocket = true;
        if (this.ws) {
          this.ws.terminate(); // Encerrar conexão imediatamente
        }
        
        // Tentar reconectar após 2 segundos
        setTimeout(() => {
          this.forceRestartWebSocket = false;
          if (this.isRunning) {
            this.websocketHandler().catch(() => {
              this.log('error', 'Falha na reconexão do WebSocket, mudando para API REST');
              this.fallbackPriceMonitor();
            });
          }
        }, 2000);
      }
    }, 10000); // Verificar a cada 10 segundos
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
  
  async reconnectWebSocket() {
    if (this.reconnectCount >= this.config.maxReconnectAttempts) {
      this.log('error', `Máximo de tentativas de reconexão atingido (${this.config.maxReconnectAttempts}). Mudando para fallback API REST.`);
      this.usingWebSocket = false;
      await this.fallbackPriceMonitor();
      return;
    }
    
    this.reconnectCount++;
    const delay = this.config.websocketReconnectDelay * 1000 * this.reconnectCount;
    
    this.log('info', `Tentativa de reconexão ${this.reconnectCount}/${this.config.maxReconnectAttempts} em ${delay/1000}s`);
    
    setTimeout(() => {
      if (this.isRunning) {
        this.websocketHandler().catch(() => {
          this.log('error', 'Falha na reconexão, tentando novamente...');
          this.reconnectWebSocket();
        });
      }
    }, delay);
  }

  startStatsUpdate() {
    // Atualizar estatísticas a cada minuto
    this.statsUpdateInterval = setInterval(() => {
      if (!this.isRunning) return;
      this.updateStatus();
    }, 60000);
  }

  async loadOpenPositions() {
    try {
      if (this.db) {
        // CORRIGIDO: Usar métodos específicos do usuário
        this.positions = this.userId ? 
          await this.db.getUserOpenPositions(this.userId) : 
          await this.db.getOpenPositions();
        
        this.log('info', `${this.positions.length} posições abertas carregadas do banco de dados`);
        
        // Log detalhado das posições carregadas
        if (this.positions.length > 0) {
          this.log('info', '=== POSIÇÕES ABERTAS CARREGADAS ===');
          this.positions.forEach((pos, idx) => {
            this.log('info', `${idx + 1}. ID: ${pos.orderId} | Símbolo: ${pos.symbol || 'BTCUSDT'} | Quantidade: ${pos.quantity.toFixed(8)} | Preço: $${pos.buyPrice.toFixed(2)} | Data: ${pos.timestamp}`);
          });
          
          // Definir moeda ativa baseada na primeira posição
          if (this.positions[0].symbol) {
            this.activeCoin = this.positions[0].symbol;
            this.log('info', `Moeda ativa definida como: ${this.activeCoin}`);
          }
        }
      }
    } catch (error) {
      this.log('error', `Erro ao carregar posições: ${error.message}`);
      this.positions = [];
    }
  }
  
  async forceCheck() {
    this.log('info', 'Verificação forçada executada pelo usuário');
    
    // Atualizar dados das moedas
    await this.updateMonitoredCoins();
    
    if (this.currentPrice > 0) {
      await this.processPriceUpdate(this.currentPrice);
    }
  }
  
  async closeAllPositions() {
    this.log('info', 'Fechando todas as posições por solicitação do usuário');
    
    for (const position of [...this.positions]) {
      await this.executeSell(position);
    }
    
    this.updateStatus();
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      currentPrice: this.currentPrice,
      dailyLow: this.dailyLow === Infinity ? 0 : this.dailyLow,
      dailyHigh: this.dailyHigh,
      dailyTrades: this.dailyTrades,
      totalProfit: this.totalProfit,
      positions: this.positions,
      activeCoin: this.activeCoin || '-',
      testMode: false // Sempre produção
    };
  }

  getStats() {
    return {
      trades: this.dailyTrades,
      profit: this.totalProfit,
      low: this.dailyLow === Infinity ? 0 : this.dailyLow,
      high: this.dailyHigh
    };
  }

  getHistory() {
    return this.priceHistory;
  }
  
  async stop() {
    if (!this.isRunning) {
      this.log('warn', 'Bot já está parado');
      return;
    }

    this.log('info', 'Parando o bot de trading...');
    this.isRunning = false;

    this.stopWatchdog();
    this.stopCoinsUpdate();
    this.stopMarketDataUpdate();
    
    // Parar intervalos
    if (this.priceCheckInterval) {
      clearInterval(this.priceCheckInterval);
      this.priceCheckInterval = null;
    }
    
    if (this.statsUpdateInterval) {
      clearInterval(this.statsUpdateInterval);
      this.statsUpdateInterval = null;
    }
    
    await this.stopPeriodicStateSave();
    
    // Parar atualizações de saldo
    if (this.balanceManager) {
      this.balanceManager.destroy();
    }
    
    // Parar gerenciador dinâmico
    if (this.dynamicTradingManager) {
      this.dynamicTradingManager.destroy();
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.usingWebSocket = false;
    
    // CORRIGIDO: Salvar estado final no banco usando métodos específicos do usuário
    if (this.db) {
      if (this.userId) {
        await this.db.saveUserBotState(this.userId, this.totalProfit, this.dailyTrades, false);
      } else {
        await this.db.saveBotState(this.totalProfit, this.dailyTrades, false);
      }
    }
    
    this.log('info', `=== ESTATÍSTICAS FINAIS ===`);
    this.log('info', `Trades realizados hoje: ${this.dailyTrades}`);
    this.log('info', `Lucro total: $ ${this.totalProfit.toFixed(2)}`);
    this.log('info', `Posições abertas: ${this.positions.length}`);
    this.log('info', `Moeda ativa: ${this.activeCoin || 'Nenhuma'}`);
    
    if (this.positions.length > 0) {
      this.log('info', `Posições em aberto:`);
      this.positions.forEach((pos, idx) => {
        this.log('info', `  ${idx + 1}. ${pos.quantity.toFixed(8)} ${(pos.symbol || 'BTCUSDT').replace('USDT', '')} comprado por $ ${pos.buyPrice.toFixed(2)}`);
      });
    }
    
    this.updateStatus();
  }
  
  async start() {
    if (this.isRunning) {
      this.log('warn', 'Bot já está rodando');
      return;
    }

    try {
      this.log('info', '=== INICIANDO BOT DE TRADING ===');
      this.log('info', `Modo: ${this.config.tradingMode === 'dynamic' ? 'TRADING DINÂMICO' : 'MOEDA ÚNICA'}`);
      
      if (this.config.tradingMode === 'dynamic') {
        const coins = this.config.dynamicCoins || await this.getTop10CoinsByVolume();
        this.log('info', `Moedas monitoradas: ${coins.join(', ')}`);
      } else {
        this.log('info', `Símbolo: ${this.config.symbol}`);
      }
      
      this.log('info', `Ambiente: PRODUÇÃO`);
      this.log('info', `Sistema de Trade: ${this.config.tradeAmountPercent}% do saldo (Min: $${this.config.minTradeAmountUsdt} | Max: $${this.config.maxTradeAmountUsdt})`);
      this.log('info', `Meta de lucro: ${this.config.dailyProfitTarget}%`);
      this.log('info', `Stop loss: ${this.config.stopLossPercent}%`);
      this.log('info', `Max trades/dia: ${this.config.maxDailyTrades}`);
      
      if (this.config.enableReinforcement) {
        this.log('info', `Estratégia Original: ${this.config.originalStrategyPercent}%`);
        this.log('info', `Estratégia de Reforço: ${this.config.reinforcementStrategyPercent}%`);
      } else {
        this.log('info', `Estratégia de Reforço: DESABILITADA`);
      }
      
      // Validar configurações
      this.config.validate();
      
      this.isRunning = true;
      
      // CORRIGIDO: Restaurar estado do banco de dados usando métodos específicos do usuário
      if (this.db) {
        const savedState = this.userId ? 
          await this.db.getUserBotState(this.userId) : 
          await this.db.getBotState();
        
        if (savedState) {
          this.totalProfit = savedState.total_profit || 0;
          this.dailyTrades = savedState.daily_trades || 0;
          this.log('info', `Estado restaurado: Lucro total: $ ${this.totalProfit.toFixed(2)}, Trades hoje: ${this.dailyTrades}`);
        }
      }
      
      // Restaurar posições abertas
      await this.loadOpenPositions();
      
      // Validar integridade do estado
      await this.validateStateIntegrity();
      
      // Inicializar gerenciador dinâmico
      if (this.config.tradingMode === 'dynamic') {
        await this.dynamicTradingManager.initializeCoinStates();
      }
      
      // Iniciar salvamento periódico
      await this.startPeriodicStateSave();
      
      // Iniciar gerenciamento de saldo
      this.balanceManager.startAutoUpdate(5); // Atualizar a cada 5 minutos
      
      // Iniciar atualização de moedas monitoradas
      this.startCoinsUpdate();
      
      // Iniciar atualização de dados de mercado em tempo real
      this.startMarketDataUpdate();
      
      // Obter preço inicial
      try {
        const targetSymbol = this.activeCoin || this.config.symbol;
        const price = await this.api.getCurrentPrice(targetSymbol);
        
        if (price > 0) {
          this.log('info', `Preço atual de ${targetSymbol}: $ ${price.toFixed(2)}`);
          this.currentPrice = price;
          this.dailyLow = price;
          this.dailyHigh = price;
          this.updateStatus();
        } else {
          throw new Error('Preço inválido recebido');
        }
      } catch (error) {
        this.log('error', `Erro ao verificar conectividade com API: ${error.message}`);
        this.isRunning = false;
        this.updateStatus();
        return;
      }
      
      // Verificar saldos e mostrar prévia de alocação
      try {
        const usdtBalance = await this.api.getUsdtBalance();
        
        this.log('info', `Saldo USDT (real): $ ${usdtBalance.toFixed(2)}`);
        
        if (usdtBalance < 5) {
          this.log('warn', `Saldo USDT baixo para realizar trades: $ ${usdtBalance.toFixed(2)}`);
        }
        
        // NOVO: Mostrar prévia do sistema de porcentagem
        const tradeAmount = this.config.calculateTradeAmount(usdtBalance);
        this.log('info', `💰 Sistema de Trade por Porcentagem:`);
        this.log('info', `  - Porcentagem configurada: ${this.config.tradeAmountPercent}%`);
        this.log('info', `  - Valor por trade: $${tradeAmount.toFixed(2)}`);
        this.log('info', `  - Limites: Min $${this.config.minTradeAmountUsdt} | Max $${this.config.maxTradeAmountUsdt}`);
        
        // Mostrar alocação de estratégias se habilitada
        if (this.config.enableReinforcement) {
          const allocation = this.config.calculateAllocation(usdtBalance);
          this.log('info', `Alocação - Original: $${allocation.originalStrategy.toFixed(2)} | Reforço: $${allocation.reinforcementStrategy.toFixed(2)}`);
        }
        
        // Atualizar saldos no banco
        await this.balanceManager.updateProductionBalance();
      } catch (error) {
        this.log('error', `Erro ao verificar saldos: ${error.message}`);
      }
      
      // CORRIGIDO: Marcar como rodando no banco usando métodos específicos do usuário
      if (this.db) {
        if (this.userId) {
          await this.db.setUserBotRunningState(this.userId, true);
        } else {
          await this.db.setBotRunningState(true);
        }
      }
      
      // Iniciar monitoramento de preços
      this.startPriceMonitoring();
      
      // Iniciar atualização de estatísticas
      this.startStatsUpdate();
      
      this.log('info', 'Bot iniciado com sucesso');
      this.updateStatus();
      
    } catch (error) {
      this.isRunning = false;
      this.log('error', `Erro ao iniciar bot: ${error.message}`);
      this.updateStatus();
      throw error;
    }
  }
}
