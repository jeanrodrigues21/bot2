import dotenv from 'dotenv';

dotenv.config();

export default class TradingConfig {
  constructor() {
    // Configurações do servidor (mantidas no .env)
    this.port = process.env.PORT || 3003;
    this.nodeEnv = process.env.NODE_ENV || 'development';
    this.logLevel = process.env.LOG_LEVEL || 'info';
    
    // Configurações padrão (serão sobrescritas pelo banco de dados)
    this.apiKey = process.env.BINANCE_API_KEY || '';
    this.apiSecret = process.env.BINANCE_SECRET_KEY || '';
    this.baseUrl = process.env.BINANCE_BASE_URL || 'https://api.binance.com';
    this.wsUrl = process.env.BINANCE_WS_URL || 'wss://stream.binance.com:9443';
    
    // Configurações de trading (valores padrão)
    this.symbol = 'BTCUSDT';
    this.testMode = false; // Sempre produção
    this.dailyProfitTarget = 0.3;
    this.stopLossPercent = 1.5;
    this.minPriceChange = 0.5;
    
    // NOVO: Sistema de porcentagem do saldo
    this.tradeAmountPercent = 10.0; // 10% do saldo por padrão
    this.minTradeAmountUsdt = 5.0; // Valor mínimo em USDT
    this.maxTradeAmountUsdt = 10000.0; // Valor máximo em USDT
    
    // Manter compatibilidade com valor fixo (será removido gradualmente)
    this.tradeAmountUsdt = 100.0;
    
    this.maxDailyTrades = 3;
    
    // NOVAS CONFIGURAÇÕES - Trading Dinâmico
    this.tradingMode = 'single'; // 'single' ou 'dynamic'
    this.dynamicCoins = [
      'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT',
      'XRPUSDT', 'DOTUSDT', 'DOGEUSDT', 'AVAXUSDT', 'MATICUSDT'
    ];
    
    // NOVAS CONFIGURAÇÕES - Estratégias de Alocação
    this.originalStrategyPercent = 70; // 70% para estratégia original
    this.reinforcementStrategyPercent = 30; // 30% para estratégia de reforço
    this.reinforcementTriggerPercent = 1.0; // Trigger de 1% de queda
    this.enableReinforcement = true; // Habilitar estratégia de reforço
    
    // Configurações avançadas (valores padrão)
    this.maxHistorySize = 1000;
    this.buyThresholdFromLow = 0.2;
    this.minHistoryForAnalysis = 20;
    this.recentTrendWindow = 10;
    this.buyCooldownSeconds = 300;
    this.minPriceChangeLog = 0.01;
    this.pricePollInterval = 10;
    this.logFrequency = 60;
    this.websocketReconnectDelay = 5;
    this.maxReconnectAttempts = 5;
    
    // Taxas (valores padrão)
    this.makerFee = 0.001;
    this.takerFee = 0.001;
    
    // NOVA CONFIGURAÇÃO - Estratégia de compra na queda da máxima
    this.buyOnDropPercent = 0.7; // Porcentagem de queda da máxima para ativar compra
  }
  
  // Atualizar configurações com dados do banco
  updateFromDatabase(dbConfig) {
    if (!dbConfig) return;
    
    // Trading básico
    this.symbol = dbConfig.symbol || this.symbol;
    
    // NOVO: Sistema de porcentagem
    this.tradeAmountPercent = dbConfig.tradeAmountPercent || this.tradeAmountPercent;
    this.minTradeAmountUsdt = dbConfig.minTradeAmountUsdt || this.minTradeAmountUsdt;
    this.maxTradeAmountUsdt = dbConfig.maxTradeAmountUsdt || this.maxTradeAmountUsdt;
    
    // Manter compatibilidade com valor fixo
    this.tradeAmountUsdt = dbConfig.tradeAmountUsdt || this.tradeAmountUsdt;
    
    this.dailyProfitTarget = dbConfig.dailyProfitTarget || this.dailyProfitTarget;
    this.stopLossPercent = dbConfig.stopLossPercent || this.stopLossPercent;
    this.maxDailyTrades = dbConfig.maxDailyTrades || this.maxDailyTrades;
    this.minPriceChange = dbConfig.minPriceChange || this.minPriceChange;
    
    // Trading dinâmico
    this.tradingMode = dbConfig.tradingMode || this.tradingMode;
    this.dynamicCoins = dbConfig.dynamicCoins || this.dynamicCoins;
    
    // Estratégias de alocação
    this.originalStrategyPercent = dbConfig.originalStrategyPercent || this.originalStrategyPercent;
    this.reinforcementStrategyPercent = dbConfig.reinforcementStrategyPercent || this.reinforcementStrategyPercent;
    this.reinforcementTriggerPercent = dbConfig.reinforcementTriggerPercent || this.reinforcementTriggerPercent;
    this.enableReinforcement = dbConfig.enableReinforcement !== undefined ? dbConfig.enableReinforcement : this.enableReinforcement;
    
    // API
    this.apiKey = dbConfig.apiKey || this.apiKey;
    this.apiSecret = dbConfig.apiSecret || this.apiSecret;
    this.baseUrl = dbConfig.baseUrl || this.baseUrl;
    
    // Advanced
    this.buyThresholdFromLow = dbConfig.buyThresholdFromLow || this.buyThresholdFromLow;
    this.minHistoryForAnalysis = dbConfig.minHistoryForAnalysis || this.minHistoryForAnalysis;
    this.recentTrendWindow = dbConfig.recentTrendWindow || this.recentTrendWindow;
    this.buyCooldownSeconds = dbConfig.buyCooldownSeconds || this.buyCooldownSeconds;
    this.pricePollInterval = dbConfig.pricePollInterval || this.pricePollInterval;
    this.logFrequency = dbConfig.logFrequency || this.logFrequency;
    this.makerFee = dbConfig.makerFee || this.makerFee;
    this.takerFee = dbConfig.takerFee || this.takerFee;
    
    // Nova estratégia
    this.buyOnDropPercent = dbConfig.buyOnDropPercent || this.buyOnDropPercent;
  }
  
  validate() {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('Credenciais da API não encontradas. Configure através da interface.');
    }
    
    if (this.apiKey.length < 20) {
      throw new Error('API Key parece estar incorreta (muito curta)');
    }
    
    if (this.apiSecret.length < 20) {
      throw new Error('Secret Key parece estar incorreta (muito curta)');
    }
    
    if (this.tradeAmountPercent <= 0 || this.tradeAmountPercent > 100) {
      throw new Error('Porcentagem de trade deve estar entre 0.1% e 100%');
    }
    
    if (this.dailyProfitTarget <= 0) {
      throw new Error('Meta de lucro deve ser positiva');
    }
    
    // Validar alocação de estratégias
    if (this.enableReinforcement && this.originalStrategyPercent + this.reinforcementStrategyPercent !== 100) {
      throw new Error('A soma das porcentagens das estratégias deve ser 100%');
    }
    
    if (this.enableReinforcement && (this.originalStrategyPercent < 10 || this.originalStrategyPercent > 90)) {
      throw new Error('Estratégia original deve ter entre 10% e 90% do saldo');
    }
    
    return true;
  }
  
  validateCredentials() {
    const issues = [];
    
    if (!this.apiKey) {
      issues.push('API Key não encontrada');
    } else if (this.apiKey.length < 20) {
      issues.push('API Key parece estar incorreta (muito curta)');
    }
    
    if (!this.apiSecret) {
      issues.push('Secret Key não encontrada');
    } else if (this.apiSecret.length < 20) {
      issues.push('Secret Key parece estar incorreta (muito curta)');
    }
    
    return {
      valid: issues.length === 0,
      issues
    };
  }
  
  // NOVO: Calcular valor de trade baseado na porcentagem do saldo
  calculateTradeAmount(totalUsdtBalance) {
    if (!totalUsdtBalance || totalUsdtBalance <= 0) {
      return this.minTradeAmountUsdt;
    }
    
    // Calcular valor baseado na porcentagem
    const calculatedAmount = (totalUsdtBalance * this.tradeAmountPercent) / 100;
    
    // Aplicar limites mínimo e máximo
    const finalAmount = Math.max(
      this.minTradeAmountUsdt,
      Math.min(calculatedAmount, this.maxTradeAmountUsdt)
    );
    
    // Garantir que não exceda o saldo disponível (deixar 1% de margem)
    const maxAllowed = totalUsdtBalance * 0.99;
    
    return Math.min(finalAmount, maxAllowed);
  }
  
  // CORRIGIDO: Calcular valores de alocação baseados no saldo total
  calculateAllocation(totalUsdtBalance) {
    if (!totalUsdtBalance || totalUsdtBalance <= 0) {
      return {
        originalStrategy: 0,
        reinforcementStrategy: 0,
        total: 0
      };
    }
    
    const originalAmount = (totalUsdtBalance * this.originalStrategyPercent) / 100;
    const reinforcementAmount = (totalUsdtBalance * this.reinforcementStrategyPercent) / 100;
    
    return {
      originalStrategy: originalAmount,
      reinforcementStrategy: reinforcementAmount,
      total: totalUsdtBalance
    };
  }
}