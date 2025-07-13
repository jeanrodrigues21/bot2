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
import SystemMonitor from './systemMonitor.js';

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
global.userBots = new Map(); // Map<userId, TradingBot>
global.userBalanceManagers = new Map(); // Map<userId, BalanceManager>
global.systemMonitor = null;
global.wss = wss; // CORRIGIDO: Tornar WebSocket disponível globalmente
global.server = server; // CORRIGIDO: Tornar servidor disponível globalmente

// WebSocket broadcast function
const broadcast = (data) => {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      // CORRIGIDO: Verificar se o cliente pertence ao usuário específico
      if (data.userId && client.userId && client.userId !== data.userId) {
        return; // Não enviar para outros usuários
      }
      
      // Se não há userId específico, é uma mensagem global (sistema)
      if (!data.userId) {
        client.send(message);
      } else if (client.userId === data.userId) {
        client.send(message);
      }
    }
  });
};

// Tornar broadcast disponível globalmente
global.broadcast = broadcast;

// NOVO: Função de broadcast específica por usuário
global.broadcastToUser = (userId, data) => {
  const message = JSON.stringify({ ...data, userId });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN && client.userId === userId) {
      client.send(message);
    }
  });
};

// WebSocket connection handler
wss.on('connection', (ws) => {
  global.logger.info('Cliente WebSocket conectado');
  
  // CORRIGIDO: Aguardar autenticação antes de enviar dados
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Autenticar cliente WebSocket
      if (data.type === 'auth' && data.token) {
        const decoded = global.authManager?.verifyToken(data.token);
        if (decoded) {
          ws.userId = decoded.id;
          ws.username = decoded.username;
          
          global.logger.info(`Cliente WebSocket autenticado: ${decoded.username} (ID: ${decoded.id})`);
          
          // Enviar status inicial específico do usuário
          const userStatus = await getUserBotStatus(decoded.id);
          ws.send(JSON.stringify({
            type: 'status',
            data: userStatus,
            userId: decoded.id
          }));
          
          // Confirmar autenticação
          ws.send(JSON.stringify({
            type: 'auth_success',
            userId: decoded.id
          }));
        } else {
          ws.send(JSON.stringify({
            type: 'auth_error',
            message: 'Token inválido'
          }));
        }
      }
    } catch (error) {
      global.logger.error('Erro ao processar mensagem WebSocket:', error);
    }
  });
  
  ws.on('close', () => {
    if (ws.username) {
      global.logger.info(`Cliente WebSocket desconectado: ${ws.username}`);
    } else {
      global.logger.info('Cliente WebSocket desconectado');
    }
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
    // Balance manager global não é mais necessário
    // Cada usuário terá seu próprio balance manager
    global.logger.info('BalanceManager inicializado com sucesso');
  } catch (error) {
    global.logger.error('Erro ao inicializar BalanceManager:', error);
    throw error;
  }
};

// CORRIGIDO: Inicialização do SystemMonitor
const initializeSystemMonitor = async () => {
  try {
    global.logger.info('🔍 Inicializando SystemMonitor...');
    global.systemMonitor = new SystemMonitor();
    
    // Aguardar um pouco para garantir que outros componentes estejam inicializados
    setTimeout(() => {
      if (global.systemMonitor) {
        global.systemMonitor.start();
        global.logger.info('✅ SystemMonitor iniciado com sucesso');
      }
    }, 3000);
    
  } catch (error) {
    global.logger.error('❌ Erro ao inicializar SystemMonitor:', error);
  }
};

// CORRIGIDO: Recuperar estado de todos os usuários
const recoverBotState = async () => {
  try {
    if (!global.db) {
      global.logger.warn('Database não inicializado para recuperar estado do bot');
      return;
    }

    global.logger.info('🔄 Iniciando recuperação de estado multi-usuário...');
    
    // Aguardar um pouco para garantir que o banco esteja totalmente inicializado
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Obter todos os usuários que tinham bots rodando
    const runningUsers = await global.db.getRunningUserBots();
    
    if (runningUsers.length === 0) {
      global.logger.info('Nenhum bot estava rodando antes do reinício');
      return;
    }
    
    global.logger.info(`🎯 Encontrados ${runningUsers.length} usuários com bots que estavam rodando:`);
    runningUsers.forEach(user => {
      global.logger.info(`  - ${user.username} (ID: ${user.user_id})`);
    });
    
    // Inicializar mapas globais
    if (!global.userBots) global.userBots = new Map();
    if (!global.userBalanceManagers) global.userBalanceManagers = new Map();
    
    let successCount = 0;
    let errorCount = 0;
    
    // Recuperar cada bot de usuário
    for (const user of runningUsers) {
      try {
        global.logger.info(`🔄 Recuperando bot do usuário: ${user.username} (ID: ${user.user_id})`);
        
        // Carregar configurações do usuário
        const userConfig = await global.db.getUserBotConfig(user.user_id);
        if (!userConfig) {
          global.logger.warn(`Configurações não encontradas para usuário ${user.user_id}, pulando...`);
          await global.db.setUserBotRunningState(user.user_id, false);
          errorCount++;
          continue;
        }
        
        // Verificar se tem credenciais da API
        if (!userConfig.apiKey || !userConfig.apiSecret) {
          global.logger.warn(`❌ Credenciais da API não encontradas para usuário ${user.user_id}, marcando como parado`);
          await global.db.setUserBotRunningState(user.user_id, false);
          errorCount++;
          continue;
        }
        
        // Importar classes necessárias
        const TradingBot = (await import('./tradingBot.js')).default;
        const TradingConfig = (await import('./config.js')).default;
        const BinanceAPI = (await import('./binanceApi.js')).default;
        const BalanceManager = (await import('./balanceManager.js')).default;
        
        // Criar configuração específica do usuário
        const config = new TradingConfig();
        config.updateFromDatabase(userConfig);
        
        // Validar configurações
        try {
          config.validate();
        } catch (validationError) {
          global.logger.warn(`❌ Configurações inválidas para usuário ${user.user_id}: ${validationError.message}`);
          await global.db.setUserBotRunningState(user.user_id, false);
          errorCount++;
          continue;
        }
        
        // Testar conexão com a API antes de iniciar
        const testApi = new BinanceAPI(config);
        const connectionTest = await testApi.testConnection();
        if (!connectionTest) {
          global.logger.warn(`❌ Falha na conexão com API Binance para usuário ${user.user_id}, marcando como parado`);
          await global.db.setUserBotRunningState(user.user_id, false);
          errorCount++;
          continue;
        }
        
        // Criar instâncias específicas do usuário
        const userBot = new TradingBot(config, global.db, user.user_id);
        const userApi = new BinanceAPI(config);
        const userBalanceManager = new BalanceManager(global.db, userApi, user.user_id);
        
        // Armazenar instâncias do usuário
        global.userBots.set(user.user_id, userBot);
        global.userBalanceManagers.set(user.user_id, userBalanceManager);
        
        // Configurar callbacks específicos do usuário
        userBot.onStatusUpdate = (status) => {
          global.broadcastToUser(user.user_id, {
            type: 'status',
            data: status
          });
        };
        
        userBot.onLogMessage = (logEntry) => {
          global.broadcastToUser(user.user_id, {
            type: 'log',
            data: logEntry
          });
        };
        
        userBot.onCoinsUpdate = (coinsData) => {
          global.broadcastToUser(user.user_id, coinsData);
        };
        
        // Iniciar bot do usuário
        await userBot.start();
        
        successCount++;
        global.logger.info(`✅ Bot recuperado e iniciado com sucesso para usuário: ${user.username} (${successCount}/${runningUsers.length})`);
        
      } catch (error) {
        errorCount++;
        global.logger.error(`❌ Erro ao recuperar bot do usuário ${user.user_id} (${user.username}):`, error.message);
        // Marcar como parado em caso de erro
        try {
          await global.db.setUserBotRunningState(user.user_id, false);
        } catch (dbError) {
          global.logger.error(`Erro ao marcar bot como parado para usuário ${user.user_id}:`, dbError);
        }
      }
    }
    
    global.logger.info(`🎯 Recuperação de estado concluída:`);
    global.logger.info(`  ✅ Sucessos: ${successCount}`);
    global.logger.info(`  ❌ Erros: ${errorCount}`);
    global.logger.info(`  📊 Total de bots ativos: ${global.userBots.size}`);
    
    if (successCount > 0) {
      global.logger.info(`🚀 ${successCount} bot(s) recuperado(s) e rodando automaticamente!`);
    }
    
  } catch (error) {
    global.logger.error('❌ Erro geral na recuperação de estado:', error);
  }
};

// Global functions
global.startBot = async () => {
  try {
    // DEPRECATED: Esta função é mantida apenas para compatibilidade
    global.logger.warn('⚠️ global.startBot() está deprecated. Use startUserBot() através da API.');
    
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
        data: status,
        userId: null // Broadcast global (deprecated)
      });
    };
    
    global.tradingBot.onLogMessage = (logEntry) => {
      broadcast({
        type: 'log',
        data: logEntry,
        userId: null // Broadcast global (deprecated)
      });
    };
    
    global.tradingBot.onCoinsUpdate = (coinsData) => {
      broadcast({
        ...coinsData,
        userId: null // Broadcast global (deprecated)
      });
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
    // DEPRECATED: Esta função é mantida apenas para compatibilidade
    global.logger.warn('⚠️ global.stopBot() está deprecated. Use stopUserBot() através da API.');
    
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
      },
      userId: null // Broadcast global (deprecated)
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
    // DEPRECATED: Esta função é mantida apenas para compatibilidade
    global.logger.warn('⚠️ global.getBotConfig() está deprecated. Use getUserBotConfig() através da API.');
    
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
    // DEPRECATED: Esta função é mantida apenas para compatibilidade
    global.logger.warn('⚠️ global.saveConfig() está deprecated. Use saveUserConfig() através da API.');
    
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

// NOVO: Função auxiliar para obter status do bot do usuário
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
    global.logger.error(`Erro ao obter status do usuário ${userId}:`, error);
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
    
    // CORRIGIDO: Inicializar SystemMonitor após todos os outros componentes
    await initializeSystemMonitor();
    
    // Start HTTP server with WebSocket support
    server.listen(port, () => {
      global.logger.info(`Servidor rodando na porta ${port}`);
      global.logger.info(`Login disponível em: http://localhost:${port}`);
      global.logger.info(`Dashboard disponível em: http://localhost:${port}/dashboard`);
      global.logger.info(`Painel Admin disponível em: http://localhost:${port}/gerenciamento`);
      global.logger.info('WebSocket server iniciado');
      global.logger.info('Sistema de autenticação multi-usuário ativo');
      global.logger.info('Sistema de trading dinâmico ativo');
      global.logger.info('Sistema multi-usuário independente ativo');
      global.logger.info('Sistema de monitoramento ativo');
      
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