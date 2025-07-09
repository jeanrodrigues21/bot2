import express from 'express';
import logger from '../logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rota para obter status do bot do usuário
router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;
    const status = await getUserBotStatus(userId);
    res.json(status);
  } catch (error) {
    logger.error('Erro ao obter status:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para iniciar o bot do usuário
router.post('/start', async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await startUserBot(userId);
    res.json(result);
  } catch (error) {
    logger.error('Erro ao iniciar bot via API:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para parar o bot do usuário
router.post('/stop', async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await stopUserBot(userId);
    res.json(result);
  } catch (error) {
    logger.error('Erro ao parar bot via API:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para verificação forçada do usuário
router.post('/force-check', async (req, res) => {
  try {
    const userId = req.user.id;
    const userBot = global.userBots?.get(userId);
    
    if (userBot && userBot.isRunning) {
      await userBot.checkPrice();
      await userBot.evaluatePositions();
      res.json({ success: true, message: 'Verificação forçada executada' });
    } else {
      res.json({ success: false, message: 'Bot não está rodando' });
    }
  } catch (error) {
    logger.error('Erro na verificação forçada:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para fechar posições do usuário
router.post('/close-positions', async (req, res) => {
  try {
    const userId = req.user.id;
    
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }
    
    const positions = await global.db.getUserOpenPositions(userId);
    
    if (positions.length === 0) {
      return res.json({ success: true, message: 'Nenhuma posição aberta para fechar' });
    }

    const userBot = global.userBots?.get(userId);
    
    // Simular fechamento de posições
    for (const position of positions) {
      const currentPrice = userBot?.priceHistory?.[userBot.priceHistory.length - 1]?.price || position.buyPrice;
      const profit = (currentPrice - position.buyPrice) * position.quantity;
      await global.db.closeUserPosition(userId, position.orderId, currentPrice, profit);
    }

    res.json({ success: true, message: `${positions.length} posições fechadas` });
  } catch (error) {
    logger.error('Erro ao fechar posições:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para obter saldos do usuário
router.get('/balance', async (req, res) => {
  try {
    const userId = req.user.id;
    
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }

    const balance = await global.db.getUserBalance(userId);
    
    logger.debug(`Saldo obtido do banco para usuário ${userId} - USDT: ${balance.usdtBalance}, BTC: ${balance.btcBalance}`);
    
    res.json({
      success: true,
      testMode: false,
      usdtBalance: balance.usdtBalance,
      btcBalance: balance.btcBalance,
      lastUpdated: balance.lastUpdated
    });
  } catch (error) {
    logger.error('Erro ao obter saldos:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para forçar atualização de saldo do usuário
router.post('/balance/update', async (req, res) => {
  try {
    const userId = req.user.id;
    const userBalanceManager = global.userBalanceManagers?.get(userId);
    
    if (!userBalanceManager) {
      return res.status(500).json({
        success: false,
        message: 'BalanceManager do usuário não inicializado'
      });
    }

    const balance = await userBalanceManager.forceUpdateBalance();
    
    res.json({
      success: true,
      message: 'Saldo atualizado com sucesso',
      testMode: false,
      usdtBalance: balance.usdtBalance,
      btcBalance: balance.btcBalance,
      lastUpdated: balance.lastUpdated
    });
  } catch (error) {
    logger.error('Erro ao atualizar saldos:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para obter configurações do usuário
router.get('/config', async (req, res) => {
  try {
    const userId = req.user.id;
    const config = await getUserBotConfig(userId);
    res.json(config);
  } catch (error) {
    logger.error('Erro ao obter configurações:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para salvar configurações do usuário
router.post('/config', async (req, res) => {
  try {
    const userId = req.user.id;
    const newConfig = req.body;
    newConfig.testMode = false;
    
    await saveUserConfig(userId, newConfig);
    
    res.json({
      success: true,
      message: 'Configurações salvas com sucesso'
    });
  } catch (error) {
    logger.error('Erro ao salvar configurações:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para obter histórico de trades do usuário
router.get('/trades', async (req, res) => {
  try {
    const userId = req.user.id;
    
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }
    
    const limit = parseInt(req.query.limit) || 50;
    const trades = await global.db.getUserTradeHistory(userId, limit);
    
    res.json({
      success: true,
      data: trades
    });
  } catch (error) {
    logger.error('Erro ao obter histórico de trades:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para obter estatísticas diárias do usuário
router.get('/stats', async (req, res) => {
  try {
    const userId = req.user.id;
    
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }
    
    const days = parseInt(req.query.days) || 30;
    const stats = await global.db.getUserDailyStats(userId, days);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    logger.error('Erro ao obter estatísticas:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para obter histórico de preços do usuário
router.get('/prices', async (req, res) => {
  try {
    const userId = req.user.id;
    
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }
    
    const hours = parseInt(req.query.hours) || 24;
    const config = await global.db.getUserBotConfig(userId);
    const symbol = config?.symbol || 'BTCUSDT';
    
    const prices = await global.db.getPriceHistory(symbol, hours);
    
    res.json({
      success: true,
      data: prices
    });
  } catch (error) {
    logger.error('Erro ao obter histórico de preços:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Funções auxiliares para gerenciamento de usuários

async function getUserBotStatus(userId) {
  try {
    const userBot = global.userBots?.get(userId);
    const userState = await global.db.getUserBotState(userId);
    
    if (!userBot) {
      return {
        isRunning: false,
        currentPrice: 0,
        dailyLow: 0,
        dailyHigh: 0,
        dailyTrades: userState?.daily_trades || 0,
        totalProfit: userState?.total_profit || 0,
        positions: [],
        activeCoin: '-',
        testMode: false
      };
    }
    
    const status = userBot.getStatus();
    return {
      isRunning: userBot.isRunning,
      currentPrice: status.currentPrice || 0,
      dailyLow: status.dailyLow || 0,
      dailyHigh: status.dailyHigh || 0,
      dailyTrades: status.dailyTrades || 0,
      totalProfit: status.totalProfit || 0,
      positions: status.positions || [],
      activeCoin: status.activeCoin || '-',
      testMode: false
    };
  } catch (error) {
    logger.error(`Erro ao obter status do usuário ${userId}:`, error);
    return {
      isRunning: false,
      currentPrice: 0,
      dailyLow: 0,
      dailyHigh: 0,
      dailyTrades: 0,
      totalProfit: 0,
      positions: [],
      activeCoin: '-',
      testMode: false
    };
  }
}

async function startUserBot(userId) {
  try {
    logger.info(`🚀 Iniciando bot para usuário ${userId}...`);
    
    // Parar bot existente se houver
    if (global.userBots?.has(userId)) {
      logger.info(`Parando bot existente do usuário ${userId}...`);
      await stopUserBot(userId);
    }
    
    // Carregar configurações do usuário
    const userConfig = await global.db.getUserBotConfig(userId);
    if (!userConfig) {
      throw new Error('Configurações do usuário não encontradas');
    }
    
    // Verificar credenciais básicas
    if (!userConfig.apiKey || !userConfig.apiSecret) {
      throw new Error('Credenciais da API Binance não configuradas');
    }
    
    // Importar classes necessárias
    const TradingBot = (await import('../tradingBot.js')).default;
    const TradingConfig = (await import('../config.js')).default;
    const BinanceAPI = (await import('../binanceApi.js')).default;
    const BalanceManager = (await import('../balanceManager.js')).default;
    
    // Criar configuração específica do usuário
    const config = new TradingConfig();
    config.updateFromDatabase(userConfig);
    config.validate();
    
    // Testar conexão com a API antes de iniciar
    logger.info(`Testando conexão com API Binance para usuário ${userId}...`);
    const testApi = new BinanceAPI(config);
    const connectionTest = await testApi.testConnection();
    if (!connectionTest) {
      throw new Error('Falha na conexão com a API Binance. Verifique suas credenciais.');
    }
    
    // Criar instâncias específicas do usuário
    const userBot = new TradingBot(config, global.db, userId);
    const userApi = new BinanceAPI(config);
    const userBalanceManager = new BalanceManager(global.db, userApi, userId);
    
    // Inicializar mapas globais se não existirem
    if (!global.userBots) global.userBots = new Map();
    if (!global.userBalanceManagers) global.userBalanceManagers = new Map();
    
    // Armazenar instâncias do usuário
    global.userBots.set(userId, userBot);
    global.userBalanceManagers.set(userId, userBalanceManager);
    
    // Configurar callbacks para WebSocket
    userBot.onStatusUpdate = (status) => {
      // CORRIGIDO: Broadcast específico para o usuário
      global.broadcastToUser?.(userId, {
        type: 'status',
        data: status
      });
    };
    
    userBot.onLogMessage = (logEntry) => {
      // CORRIGIDO: Logs específicos para o usuário
      global.broadcastToUser?.(userId, {
        type: 'log',
        data: logEntry
      });
    };
    
    userBot.onCoinsUpdate = (coinsData) => {
      // CORRIGIDO: Dados de moedas específicos para o usuário
      global.broadcastToUser?.(userId, coinsData);
    };
    
    // Iniciar bot do usuário
    logger.info(`Iniciando instância do bot para usuário ${userId}...`);
    await userBot.start();
    
    // Salvar estado no banco
    logger.info(`Salvando estado 'rodando' no banco para usuário ${userId}...`);
    await global.db.setUserBotRunningState(userId, true);
    
    logger.info(`✅ Bot iniciado com sucesso para usuário ${userId}`);
    return { success: true, message: 'Bot iniciado com sucesso' };
  } catch (error) {
    logger.error(`❌ Erro ao iniciar bot do usuário ${userId}:`, error.message);
    
    // Marcar como parado em caso de erro
    try {
      await global.db.setUserBotRunningState(userId, false);
      logger.info(`Estado marcado como 'parado' no banco para usuário ${userId}`);
    } catch (dbError) {
      logger.error('Erro ao salvar estado do bot no banco:', dbError);
    }
    
    return { success: false, error: error.message };
  }
}

async function stopUserBot(userId) {
  try {
    logger.info(`🛑 Parando bot para usuário ${userId}...`);
    
    const userBot = global.userBots?.get(userId);
    
    if (userBot) {
      logger.info(`Parando instância do bot para usuário ${userId}...`);
      await userBot.stop();
      global.userBots.delete(userId);
    }
    
    // Parar balance manager do usuário
    const userBalanceManager = global.userBalanceManagers?.get(userId);
    if (userBalanceManager) {
      logger.info(`Parando balance manager para usuário ${userId}...`);
      userBalanceManager.destroy();
      global.userBalanceManagers.delete(userId);
    }
    
    // Salvar estado no banco
    logger.info(`Salvando estado 'parado' no banco para usuário ${userId}...`);
    await global.db.setUserBotRunningState(userId, false);
    
    logger.info(`✅ Bot parado com sucesso para usuário ${userId}`);
    return { success: true, message: 'Bot parado com sucesso' };
  } catch (error) {
    logger.error(`❌ Erro ao parar bot do usuário ${userId}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function getUserBotConfig(userId) {
  try {
    const config = await global.db.getUserBotConfig(userId);
    
    if (!config) {
      // Retornar configurações padrão para novo usuário
      return {
        symbol: 'BTCUSDT',
        tradeAmountUsdt: 100,
        tradeAmountPercent: 10.0,
        minTradeAmountUsdt: 5.0,
        maxTradeAmountUsdt: 10000.0,
        dailyProfitTarget: 1.0,
        stopLossPercent: 2.0,
        maxDailyTrades: 10,
        minPriceChange: 0.5,
        tradingMode: 'single',
        dynamicCoins: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT'],
        originalStrategyPercent: 70,
        reinforcementStrategyPercent: 30,
        reinforcementTriggerPercent: 1.0,
        enableReinforcement: true,
        apiKey: '',
        apiSecret: '',
        baseUrl: 'https://api.binance.com',
        buyThresholdFromLow: 0.2,
        minHistoryForAnalysis: 20,
        recentTrendWindow: 10,
        buyCooldownSeconds: 300,
        pricePollInterval: 10,
        logFrequency: 60,
        makerFee: 0.001,
        takerFee: 0.001,
        testMode: false
      };
    }
    
    return config;
  } catch (error) {
    logger.error(`Erro ao obter configurações do usuário ${userId}:`, error);
    throw error;
  }
}

async function saveUserConfig(userId, newConfig) {
  try {
    newConfig.testMode = false;
    await global.db.saveUserBotConfig(userId, newConfig);
    
    // Atualizar bot em execução se existir
    const userBot = global.userBots?.get(userId);
    if (userBot) {
      userBot.updateConfig(newConfig);
    }
    
    logger.info(`Configurações salvas para usuário ${userId}`);
    return { success: true, message: 'Configurações salvas com sucesso' };
  } catch (error) {
    logger.error(`Erro ao salvar configurações do usuário ${userId}:`, error);
    throw error;
  }
}

export default router;