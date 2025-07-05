import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import TradingBot from './tradingBot.js';
import TradingConfig from './config.js';
import Database from './database.js';
import BalanceManager from './balanceManager.js';
import BinanceAPI from './binanceApi.js';
import AuthManager from './auth.js';
import Logger from './logger.js';
import apiRoutes from './routes/api.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';

// Load environment variables first
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3003;

// Create HTTP server
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());

// Servir arquivos estáticos da nova estrutura
app.use('/static', express.static(path.join(__dirname, '../../public/static')));
app.use(express.static(path.join(__dirname, '../../public')));

// Global variables
global.tradingBot = null;
global.logger = Logger;
global.db = null;
global.balanceManager = null;
global.authManager = null;

// WebSocket broadcast function
const broadcast = (data) => {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
};

// WebSocket connection handler
wss.on('connection', (ws) => {
  global.logger.info('Cliente WebSocket conectado');
  
  // Send initial status
  if (global.tradingBot) {
    const status = global.getBotStatus();
    ws.send(JSON.stringify({
      type: 'status',
      data: status
    }));
  }
  
  ws.on('close', () => {
    global.logger.info('Cliente WebSocket desconectado');
  });
  
  ws.on('error', (error) => {
    global.logger.error('Erro WebSocket:', error);
  });
});

// CORRIGIDO: Middleware de autenticação mais específico
const authenticateToken = async (req, res, next) => {
  // Log da requisição para debug
  global.logger.info(`🌐 Requisição: ${req.method} ${req.path}`);
  
  // Rotas que NÃO precisam de autenticação
  const publicPaths = [
    '/',
    '/dashboard',
    '/gerenciamento',
    '/auth/login',
    '/auth/register',
    '/auth/verify'
  ];
  
  // Verificar se é uma rota pública
  if (publicPaths.includes(req.path)) {
    global.logger.info(`✅ Rota pública permitida: ${req.path}`);
    return next();
  }
  
  // Verificar se é arquivo estático
  if (req.path.startsWith('/static/')) {
    global.logger.info(`✅ Arquivo estático permitido: ${req.path}`);
    return next();
  }
  
  // Para todas as outras rotas (especialmente /api/*), verificar autenticação
  if (!global.authManager) {
    global.logger.error('❌ AuthManager não inicializado');
    return res.status(500).json({ error: 'Sistema de autenticação não disponível' });
  }
  
  global.logger.info(`🔐 Verificando autenticação para: ${req.path}`);
  return global.authManager.authenticateToken(req, res, next);
};

// Routes
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);

// CORRIGIDO: Aplicar autenticação apenas para rotas da API
app.use('/api', authenticateToken, apiRoutes);

// Rotas de páginas (sem autenticação para servir HTML)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/views/login.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/views/dashboard.html'));
});

app.get('/gerenciamento', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/views/admin.html'));
});

// Initialize database
const initializeDatabase = async () => {
  try {
    const Database = (await import('./database.js')).default;
    global.db = new Database();
    await global.db.init();
    global.logger.info('Database inicializado com sucesso');
  } catch (error) {
    global.logger.error('Erro ao inicializar database:', error);
    throw error;
  }
};

// Initialize auth manager
const initializeAuthManager = async () => {
  try {
    global.authManager = new AuthManager(global.db);
    global.authManager.startSessionCleanup();
    global.logger.info('AuthManager inicializado com sucesso');
  } catch (error) {
    global.logger.error('Erro ao inicializar AuthManager:', error);
    throw error;
  }
};

// Initialize balance manager
const initializeBalanceManager = async () => {
  try {
    // Carregar configurações do banco primeiro
    const dbConfig = await global.db.getBotConfig();
    const config = new TradingConfig();
    config.updateFromDatabase(dbConfig);
    
    const api = new BinanceAPI(config);
    global.balanceManager = new BalanceManager(global.db, api);
    global.logger.info('BalanceManager inicializado com sucesso');
  } catch (error) {
    global.logger.error('Erro ao inicializar BalanceManager:', error);
    throw error;
  }
};

const recoverBotState = async () => {
  try {
    if (!global.db) {
      global.logger.warn('Database não inicializado para recuperar estado do bot');
      return;
    }

    // Verificar se o bot estava rodando antes do servidor parar
    const wasRunning = await global.db.getBotRunningState();
    
    if (wasRunning) {
      global.logger.info('Bot estava em execução antes da parada do servidor');
      global.logger.info('Tentando reiniciar o bot automaticamente...');
      
      // Tentar reiniciar o bot automaticamente
      const result = await global.startBot();
      
      if (result.success) {
        global.logger.info('Bot reiniciado automaticamente com sucesso');
      } else {
        global.logger.error('Falha ao reiniciar bot automaticamente:', result.error);
        // Marcar bot como parado no banco se falhou ao reiniciar
        await global.db.setBotRunningState(false);
      }
    } else {
      global.logger.info('Bot não estava em execução antes da parada do servidor');
    }
  } catch (error) {
    global.logger.error('Erro ao recuperar estado do bot:', error);
    // Em caso de erro, assumir que bot não estava rodando
    try {
      await global.db.setBotRunningState(false);
    } catch (dbError) {
      global.logger.error('Erro ao marcar bot como parado:', dbError);
    }
  }
};

// Global functions
global.startBot = async () => {
  try {
    if (global.tradingBot) {
      await global.tradingBot.stop();
    }
    
    // Carregar configurações do banco de dados
    const dbConfig = await global.db.getBotConfig();
    const config = new TradingConfig();
    config.updateFromDatabase(dbConfig);
    
    config.validate();
    
    global.tradingBot = new TradingBot(config, global.db);
    
    // Set up callbacks for WebSocket broadcasting
    global.tradingBot.onStatusUpdate = (status) => {
      broadcast({
        type: 'status',
        data: status
      });
    };
    
    global.tradingBot.onLogMessage = (logEntry) => {
      broadcast({
        type: 'log',
        data: logEntry
      });
    };
    
    // NOVO: Callback para atualização de moedas
    global.tradingBot.onCoinsUpdate = (coinsData) => {
      broadcast(coinsData);
    };
    
    await global.tradingBot.start();
    
    // Salvar estado no banco de dados
    if (global.db) {
      await global.db.setBotRunningState(true);
    }
    
    global.logger.info('Bot iniciado com sucesso');
    return { success: true, message: 'Bot iniciado com sucesso' };
  } catch (error) {
    global.logger.error('Erro ao iniciar bot:', error);
    
    // Marcar como parado em caso de erro
    if (global.db) {
      try {
        await global.db.setBotRunningState(false);
      } catch (dbError) {
        global.logger.error('Erro ao salvar estado do bot no banco:', dbError);
      }
    }
    
    return { success: false, error: error.message };
  }
};

global.stopBot = async () => {
  try {
    if (global.tradingBot) {
      await global.tradingBot.stop();
      global.tradingBot = null;
    }
    
    // Salvar estado no banco de dados
    if (global.db) {
      await global.db.setBotRunningState(false);
    }
    
    // Broadcast stop status
    broadcast({
      type: 'status',
      data: {
        isRunning: false,
        currentPrice: 0,
        dailyLow: 0,
        dailyHigh: 0,
        dailyTrades: 0,
        totalProfit: 0,
        positions: [],
        activeCoin: '-',
        testMode: false // Sempre produção
      }
    });
    
    global.logger.info('Bot parado com sucesso');
    return { success: true, message: 'Bot parado com sucesso' };
  } catch (error) {
    global.logger.error('Erro ao parar bot:', error);
    return { success: false, error: error.message };
  }
};

global.getBotStatus = () => {
  if (!global.tradingBot) {
    return {
      isRunning: false,
      currentPrice: 0,
      dailyLow: 0,
      dailyHigh: 0,
      dailyTrades: 0,
      totalProfit: 0,
      positions: [],
      activeCoin: '-',
      testMode: false // Sempre produção
    };
  }
  
  const status = global.tradingBot.getStatus();
  return {
    isRunning: global.tradingBot.isRunning,
    currentPrice: status.currentPrice || 0,
    dailyLow: status.dailyLow || 0,
    dailyHigh: status.dailyHigh || 0,
    dailyTrades: status.dailyTrades || 0,
    totalProfit: status.totalProfit || 0,
    positions: status.positions || [],
    activeCoin: status.activeCoin || '-',
    testMode: false // Sempre produção
  };
};

global.getBotStats = () => {
  if (!global.tradingBot) {
    return null;
  }
  
  return global.tradingBot.getStats();
};

global.getBotHistory = () => {
  if (!global.tradingBot) {
    return [];
  }
  
  return global.tradingBot.getHistory();
};

global.getBotConfig = async () => {
  try {
    if (!global.db) {
      return {
        tradeAmountUsdt: 100,
        dailyProfitTarget: 1.0,
        stopLossPercent: 2.0,
        maxDailyTrades: 10,
        minPriceChange: 0.5,
        tradingMode: 'single',
        dynamicCoins: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
        testMode: false // Sempre produção
      };
    }
    
    const config = await global.db.getBotConfig();
    return config || {
      tradeAmountUsdt: 100,
      dailyProfitTarget: 1.0,
      stopLossPercent: 2.0,
      maxDailyTrades: 10,
      minPriceChange: 0.5,
      tradingMode: 'single',
      dynamicCoins: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
      testMode: false // Sempre produção
    };
  } catch (error) {
    global.logger.error('Erro ao obter configurações:', error);
    return {
      tradeAmountUsdt: 100,
      dailyProfitTarget: 1.0,
      stopLossPercent: 2.0,
      maxDailyTrades: 10,
      minPriceChange: 0.5,
      tradingMode: 'single',
      dynamicCoins: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'],
      testMode: false // Sempre produção
    };
  }
};

global.saveConfig = async (newConfig) => {
  try {
    if (!global.db) {
      throw new Error('Database não inicializado');
    }
    
    // Forçar testMode = false (sempre produção)
    newConfig.testMode = false;
    
    await global.db.updateBotConfigFields(newConfig);
    
    // Update running bot config if exists
    if (global.tradingBot) {
      global.tradingBot.updateConfig(newConfig);
    }
    
    global.logger.info('Configurações salvas com sucesso');
    return { success: true, message: 'Configurações salvas com sucesso' };
  } catch (error) {
    global.logger.error('Erro ao salvar configurações:', error);
    throw error;
  }
};

// Start server
const startServer = async () => {
  try {
    // Initialize database first
    await initializeDatabase();
    
    // Initialize auth manager
    await initializeAuthManager();
    
    // Initialize balance manager
    await initializeBalanceManager();
    
    // Recuperar estado do bot após inicializar o database
    await recoverBotState();
    
    // Start HTTP server with WebSocket support
    server.listen(port, () => {
      global.logger.info(`Servidor rodando na porta ${port}`);
      global.logger.info(`Login disponível em: http://localhost:${port}`);
      global.logger.info(`Dashboard disponível em: http://localhost:${port}/dashboard`);
      global.logger.info(`Painel Admin disponível em: http://localhost:${port}/gerenciamento`);
      global.logger.info('WebSocket server iniciado');
      global.logger.info('Sistema de autenticação multi-usuário ativo');
      global.logger.info('Sistema de trading dinâmico ativo');
      
      // Log configuration status
      try {
        const config = new TradingConfig();
        const validation = config.validateCredentials();
        
        if (validation.valid) {
          global.logger.info('Configuração válida - credenciais da API encontradas');
        } else {
          global.logger.warn('Problemas na configuração:', validation.issues);
          global.logger.info('Configure as credenciais através da interface web');
        }
      } catch (error) {
        global.logger.error('Erro na configuração:', error.message);
      }
    });
  } catch (error) {
    global.logger.error('Erro ao iniciar servidor:', error);
    process.exit(1);
  }
};

startServer();

export default app;