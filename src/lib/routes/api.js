import express from 'express';
import logger from '../logger.js';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Rota para obter status do bot
router.get('/status', (req, res) => {
  try {
    const status = global.getBotStatus();
    res.json(status);
  } catch (error) {
    logger.error('Erro ao obter status:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para iniciar o bot
router.post('/start', async (req, res) => {
  try {
    const result = await global.startBot();
    res.json(result);
  } catch (error) {
    logger.error('Erro ao iniciar bot via API:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para parar o bot
router.post('/stop', async (req, res) => {
  try {
    const result = await global.stopBot();
    res.json(result);
  } catch (error) {
    logger.error('Erro ao parar bot via API:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para verificação forçada
router.post('/force-check', async (req, res) => {
  try {
    if (global.tradingBot && global.tradingBot.isRunning) {
      await global.tradingBot.checkPrice();
      await global.tradingBot.evaluatePositions();
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

// Rota para fechar posições
router.post('/close-positions', async (req, res) => {
  try {
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }
    
    const positions = await global.db.getOpenPositions();
    
    if (positions.length === 0) {
      return res.json({ success: true, message: 'Nenhuma posição aberta para fechar' });
    }

    // Simular fechamento de posições
    for (const position of positions) {
      const currentPrice = global.tradingBot?.priceHistory?.[global.tradingBot.priceHistory.length - 1]?.price || position.buyPrice;
      const profit = (currentPrice - position.buyPrice) * position.quantity;
      await global.db.closePosition(position.orderId, currentPrice, profit);
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

// Rota para obter saldos do banco de dados (sempre produção)
router.get('/balance', async (req, res) => {
  try {
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }

    // Sempre usar produção
    const balance = await global.db.getBalance(false);
    
    logger.debug(`Saldo obtido do banco - PRODUÇÃO, USDT: ${balance.usdtBalance}, BTC: ${balance.btcBalance}`);
    
    res.json({
      success: true,
      testMode: false, // Sempre produção
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

// Rota para forçar atualização de saldo (sempre produção)
router.post('/balance/update', async (req, res) => {
  try {
    if (!global.balanceManager) {
      return res.status(500).json({
        success: false,
        message: 'BalanceManager não inicializado'
      });
    }

    const balance = await global.balanceManager.forceUpdateBalance();
    
    res.json({
      success: true,
      message: 'Saldo atualizado com sucesso',
      testMode: false, // Sempre produção
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

// Rota para obter configurações
router.get('/config', async (req, res) => {
  try {
    const config = await global.getBotConfig();
    res.json(config);
  } catch (error) {
    logger.error('Erro ao obter configurações:', error);
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// Rota para salvar configurações
router.post('/config', async (req, res) => {
  try {
    const newConfig = req.body;
    // Forçar testMode = false (sempre produção)
    newConfig.testMode = false;
    
    await global.saveConfig(newConfig);
    
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

// Rota para obter histórico de trades
router.get('/trades', async (req, res) => {
  try {
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }
    
    const limit = parseInt(req.query.limit) || 50;
    const trades = await global.db.getTradeHistory(limit);
    
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

// Rota para obter estatísticas diárias
router.get('/stats', async (req, res) => {
  try {
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }
    
    const days = parseInt(req.query.days) || 30;
    const stats = await global.db.getDailyStats(days);
    
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

// Rota para obter histórico de preços
router.get('/prices', async (req, res) => {
  try {
    if (!global.db) {
      return res.status(500).json({
        success: false,
        message: 'Database não inicializado'
      });
    }
    
    const hours = parseInt(req.query.hours) || 24;
    const prices = await global.db.getPriceHistory('BTCUSDT', hours);
    
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

// Rota principal para servir o dashboard
router.get('/', (req, res) => {
  try {
    const dashboardPath = path.join(__dirname, '../../..', 'public', 'dashboard.html');
    res.sendFile(dashboardPath);
  } catch (error) {
    logger.error('Erro ao servir dashboard:', error);
    res.status(500).send('Erro interno do servidor');
  }
});

export default router;