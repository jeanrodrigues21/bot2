import logger from '../logger.js';

/**
 * Módulo de Recuperação Automática
 * 
 * Responsável por detectar e recuperar bots que estavam rodando
 * antes de uma reinicialização do sistema.
 */
export default class AutoRecovery {
  constructor(database, botStateManager) {
    this.db = database;
    this.stateManager = botStateManager;
    this.recoveryInProgress = false;
    this.recoveryResults = {
      attempted: 0,
      successful: 0,
      failed: 0,
      errors: []
    };
  }

  /**
   * Iniciar processo de recuperação automática
   */
  async startRecovery() {
    if (this.recoveryInProgress) {
      logger.warn('Processo de recuperação já está em andamento');
      return this.recoveryResults;
    }

    this.recoveryInProgress = true;
    this.recoveryResults = { attempted: 0, successful: 0, failed: 0, errors: [] };

    try {
      logger.info('🔄 Iniciando recuperação automática de bots...');
      
      // Aguardar um pouco para garantir que o sistema esteja totalmente inicializado
      await this.waitForSystemReady();
      
      // Obter usuários que tinham bots rodando
      const runningUsers = await this.stateManager.getRunningBots();
      
      if (runningUsers.length === 0) {
        logger.info('✅ Nenhum bot estava rodando antes da reinicialização');
        this.recoveryInProgress = false;
        return this.recoveryResults;
      }
      
      logger.info(`🎯 Encontrados ${runningUsers.length} usuários com bots que estavam rodando`);
      this.recoveryResults.attempted = runningUsers.length;
      
      // Recuperar cada bot individualmente
      for (const user of runningUsers) {
        await this.recoverUserBot(user);
        
        // Pequena pausa entre recuperações para evitar sobrecarga
        await this.sleep(2000);
      }
      
      // Log do resultado final
      this.logRecoveryResults();
      
    } catch (error) {
      logger.error('❌ Erro geral na recuperação automática:', error);
      this.recoveryResults.errors.push(`Erro geral: ${error.message}`);
    } finally {
      this.recoveryInProgress = false;
    }
    
    return this.recoveryResults;
  }

  /**
   * Recuperar bot de um usuário específico
   */
  async recoverUserBot(user) {
    const userId = user.user_id;
    const username = user.username;
    
    try {
      logger.info(`🔄 Iniciando recuperação do bot para usuário: ${username} (ID: ${userId})`);
      
      // PASSO 1: Verificar se o usuário ainda está aprovado
      logger.info(`📋 Verificando status do usuário ${username}...`);
      const currentUser = await this.db.getUserById(userId);
      if (!currentUser || !currentUser.approved) {
        logger.warn(`❌ Usuário ${username} não está mais aprovado, marcando como parado`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        this.recoveryResults.errors.push(`${username}: Usuário não aprovado`);
        return;
      }
      logger.info(`✅ Usuário ${username} está aprovado`);
      
      // PASSO 2: Carregar configurações do usuário
      logger.info(`⚙️ Carregando configurações do usuário ${username}...`);
      const userConfig = await this.db.getUserBotConfig(userId);
      if (!userConfig) {
        logger.warn(`❌ Configurações não encontradas para usuário ${username}`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        this.recoveryResults.errors.push(`${username}: Configurações não encontradas`);
        return;
      }
      logger.info(`✅ Configurações carregadas para ${username}`);
      
      // PASSO 3: Verificar credenciais da API
      logger.info(`🔑 Verificando credenciais da API para ${username}...`);
      if (!userConfig.apiKey || !userConfig.apiSecret) {
        logger.warn(`❌ Credenciais da API não encontradas para usuário ${username}`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        this.recoveryResults.errors.push(`${username}: Credenciais da API ausentes`);
        return;
      }
      logger.info(`✅ Credenciais da API encontradas para ${username}`);
      
      // PASSO 4: Importar classes necessárias
      logger.info(`📦 Importando classes de trading...`);
      const { TradingBot, TradingConfig, BinanceAPI, BalanceManager } = await this.importTradingClasses();
      logger.info(`✅ Classes de trading importadas`);
      
      // PASSO 5: Criar e validar configuração
      logger.info(`🔧 Criando configuração para ${username}...`);
      const config = new TradingConfig();
      config.updateFromDatabase(userConfig);
      
      try {
        config.validate();
        logger.info(`✅ Configuração válida para ${username}`);
      } catch (validationError) {
        logger.warn(`❌ Configurações inválidas para usuário ${username}: ${validationError.message}`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        this.recoveryResults.errors.push(`${username}: ${validationError.message}`);
        return;
      }
      
      // PASSO 6: Testar conexão com a API
      logger.info(`🌐 Testando conexão com API Binance para ${username}...`);
      const testApi = new BinanceAPI(config);
      const connectionTest = await testApi.testConnection();
      if (!connectionTest) {
        logger.warn(`❌ Falha na conexão com API Binance para usuário ${username}`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        this.recoveryResults.errors.push(`${username}: Falha na API Binance`);
        return;
      }
      logger.info(`✅ Conexão com API Binance OK para ${username}`);
      
      // PASSO 7: Criar instâncias específicas do usuário
      logger.info(`🤖 Criando instâncias do bot para ${username}...`);
      const userBot = new TradingBot(config, this.db, userId);
      const userApi = new BinanceAPI(config);
      const userBalanceManager = new BalanceManager(this.db, userApi, userId);
      logger.info(`✅ Instâncias criadas para ${username}`);
      
      // PASSO 8: Inicializar mapas globais se não existirem
      if (!global.userBots) {
        global.userBots = new Map();
        logger.info(`📋 Mapa global userBots inicializado`);
      }
      if (!global.userBalanceManagers) {
        global.userBalanceManagers = new Map();
        logger.info(`📋 Mapa global userBalanceManagers inicializado`);
      }
      
      // PASSO 9: Armazenar instâncias do usuário
      global.userBots.set(userId, userBot);
      global.userBalanceManagers.set(userId, userBalanceManager);
      logger.info(`✅ Instâncias armazenadas nos mapas globais para ${username}`);
      
      // PASSO 10: Configurar callbacks para WebSocket
      logger.info(`🔌 Configurando callbacks WebSocket para ${username}...`);
      this.setupBotCallbacks(userBot, userId);
      logger.info(`✅ Callbacks WebSocket configurados para ${username}`);
      
      // PASSO 11: Carregar estado anterior se disponível
      logger.info(`💾 Carregando estado anterior para ${username}...`);
      const previousState = await this.stateManager.loadBotState(userId);
      if (previousState && this.stateManager.isValidStateForRecovery(previousState)) {
        logger.info(`📊 Restaurando estado anterior para ${username}...`);
        await this.restoreBotState(userBot, previousState);
        logger.info(`✅ Estado anterior restaurado para ${username}`);
      } else {
        logger.info(`ℹ️ Nenhum estado anterior válido encontrado para ${username}`);
      }
      
      // PASSO 12: Iniciar bot do usuário
      logger.info(`🚀 Iniciando bot para ${username}...`);
      await userBot.start();
      logger.info(`✅ Bot iniciado com sucesso para ${username}`);
      
      // PASSO 13: Confirmar que está rodando
      if (userBot.isRunning) {
        this.recoveryResults.successful++;
        logger.info(`🎉 Bot do usuário ${username} recuperado e rodando com sucesso!`);
      } else {
        throw new Error('Bot não está marcado como rodando após inicialização');
      }
      
    } catch (error) {
      this.recoveryResults.failed++;
      this.recoveryResults.errors.push(`${username}: ${error.message}`);
      logger.error(`❌ Erro ao recuperar bot do usuário ${userId} (${username}):`, error.message);
      logger.error(`🔍 Stack trace:`, error.stack);
      
      // Marcar como parado em caso de erro
      try {
        await this.stateManager.setBotRunning(userId, false);
        logger.info(`🛑 Bot marcado como parado para usuário ${username} devido ao erro`);
      } catch (dbError) {
        logger.error(`Erro ao marcar bot como parado para usuário ${userId}:`, dbError);
      }
    }
  }

  /**
   * Restaurar estado do bot de forma segura
   */
  async restoreBotState(userBot, previousState) {
    try {
      logger.info(`🔄 Iniciando restauração de estado...`);
      
      // Restaurar propriedades básicas
      if (previousState.currentPrice && previousState.currentPrice > 0) {
        userBot.currentPrice = previousState.currentPrice;
        logger.info(`📈 Preço atual restaurado: ${previousState.currentPrice}`);
      }
      
      if (previousState.dailyLow && previousState.dailyLow !== Infinity) {
        userBot.dailyLow = previousState.dailyLow;
        logger.info(`📉 Mínima diária restaurada: ${previousState.dailyLow}`);
      }
      
      if (previousState.dailyHigh && previousState.dailyHigh > 0) {
        userBot.dailyHigh = previousState.dailyHigh;
        logger.info(`📈 Máxima diária restaurada: ${previousState.dailyHigh}`);
      }
      
      if (previousState.dailyTrades && previousState.dailyTrades >= 0) {
        userBot.dailyTrades = previousState.dailyTrades;
        logger.info(`📊 Trades diários restaurados: ${previousState.dailyTrades}`);
      }
      
      if (previousState.totalProfit !== undefined) {
        userBot.totalProfit = previousState.totalProfit;
        logger.info(`💰 Lucro total restaurado: ${previousState.totalProfit}`);
      }
      
      if (previousState.activeCoin && previousState.activeCoin !== '-') {
        userBot.activeCoin = previousState.activeCoin;
        logger.info(`🪙 Moeda ativa restaurada: ${previousState.activeCoin}`);
      }
      
      if (previousState.lastBuyTime) {
        userBot.lastBuyTime = new Date(previousState.lastBuyTime);
        logger.info(`⏰ Último tempo de compra restaurado: ${previousState.lastBuyTime}`);
      }
      
      // Restaurar histórico de preços (apenas dados recentes)
      if (previousState.priceHistory && Array.isArray(previousState.priceHistory)) {
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        
        const recentHistory = previousState.priceHistory
          .filter(entry => {
            if (!entry || !entry.timestamp || !entry.price) return false;
            const entryTime = new Date(entry.timestamp);
            return entryTime > oneDayAgo && entry.price > 0;
          })
          .slice(-1000); // Manter apenas os últimos 1000 pontos
        
        if (recentHistory.length > 0) {
          userBot.priceHistory = recentHistory;
          logger.info(`📊 Histórico de preços restaurado: ${recentHistory.length} pontos`);
        }
      }
      
      // Restaurar posições (se existirem)
      if (previousState.positions && Array.isArray(previousState.positions)) {
        const validPositions = previousState.positions.filter(pos => {
          return pos && pos.buyPrice > 0 && pos.quantity > 0 && pos.orderId;
        });
        
        if (validPositions.length > 0) {
          userBot.positions = validPositions;
          logger.info(`📋 Posições restauradas: ${validPositions.length} posições`);
        }
      }
      
      logger.info(`✅ Estado restaurado com sucesso`);
      
    } catch (error) {
      logger.error('❌ Erro ao restaurar estado do bot:', error);
      // Não falhar a recuperação por causa de erro na restauração
    }
  }

  /**
   * Configurar callbacks do bot para WebSocket
   */
  setupBotCallbacks(userBot, userId) {
    try {
      if (typeof global.broadcastToUser === 'function') {
        userBot.onStatusUpdate = (status) => {
          global.broadcastToUser(userId, {
            type: 'status',
            data: status
          });
        };
        
        userBot.onLogMessage = (logEntry) => {
          global.broadcastToUser(userId, {
            type: 'log',
            data: logEntry
          });
        };
        
        userBot.onCoinsUpdate = (coinsData) => {
          global.broadcastToUser(userId, coinsData);
        };
        
        logger.info(`✅ Callbacks WebSocket configurados para usuário ${userId}`);
      } else {
        logger.warn(`⚠️ Função broadcastToUser não disponível, callbacks não configurados`);
        
        // Configurar callbacks vazios para evitar erros
        userBot.onStatusUpdate = () => {};
        userBot.onLogMessage = () => {};
        userBot.onCoinsUpdate = () => {};
      }
    } catch (error) {
      logger.error('Erro ao configurar callbacks WebSocket:', error);
      
      // Configurar callbacks vazios em caso de erro
      userBot.onStatusUpdate = () => {};
      userBot.onLogMessage = () => {};
      userBot.onCoinsUpdate = () => {};
    }
  }

  /**
   * Importar classes de trading dinamicamente
   */
  async importTradingClasses() {
    try {
      const [
        { default: TradingBot },
        { default: TradingConfig },
        { default: BinanceAPI },
        { default: BalanceManager }
      ] = await Promise.all([
        import('../tradingBot.js'),
        import('../config.js'),
        import('../binanceApi.js'),
        import('../balanceManager.js')
      ]);
      
      return { TradingBot, TradingConfig, BinanceAPI, BalanceManager };
    } catch (error) {
      logger.error('Erro ao importar classes de trading:', error);
      throw new Error('Falha ao carregar módulos necessários');
    }
  }

  /**
   * Aguardar sistema estar pronto
   */
  async waitForSystemReady() {
    const maxWaitTime = 30000; // 30 segundos
    const checkInterval = 1000; // 1 segundo
    let waitTime = 0;
    
    logger.info('⏳ Aguardando sistema estar pronto...');
    
    while (waitTime < maxWaitTime) {
      // Verificar se componentes essenciais estão disponíveis
      if (global.db && global.authManager) {
        logger.info('✅ Sistema pronto para recuperação');
        return;
      }
      
      await this.sleep(checkInterval);
      waitTime += checkInterval;
      
      if (waitTime % 5000 === 0) {
        logger.info(`⏳ Aguardando sistema... ${waitTime/1000}s`);
      }
    }
    
    logger.warn('⚠️ Sistema pode não estar totalmente pronto, prosseguindo com recuperação');
  }

  /**
   * Log dos resultados da recuperação
   */
  logRecoveryResults() {
    const { attempted, successful, failed, errors } = this.recoveryResults;
    
    logger.info(`🎯 Recuperação automática concluída:`);
    logger.info(`  ✅ Sucessos: ${successful}`);
    logger.info(`  ❌ Falhas: ${failed}`);
    logger.info(`  📊 Total tentativas: ${attempted}`);
    
    if (successful > 0) {
      logger.info(`🚀 ${successful} bot(s) recuperado(s) e rodando automaticamente!`);
    }
    
    if (errors.length > 0) {
      logger.warn('❌ Erros durante a recuperação:');
      errors.forEach(error => logger.warn(`  - ${error}`));
    }
    
    if (failed === 0 && successful > 0) {
      logger.info('🎉 Recuperação automática 100% bem-sucedida!');
    }
  }

  /**
   * Verificar se a recuperação está em andamento
   */
  isRecoveryInProgress() {
    return this.recoveryInProgress;
  }

  /**
   * Obter resultados da última recuperação
   */
  getLastRecoveryResults() {
    return this.recoveryResults;
  }

  /**
   * Função auxiliar para sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Forçar recuperação de um usuário específico
   */
  async forceRecoverUser(userId) {
    try {
      const user = await this.db.getUserById(userId);
      if (!user) {
        throw new Error('Usuário não encontrado');
      }
      
      const userWithState = {
        user_id: user.id,
        username: user.username
      };
      
      await this.recoverUserBot(userWithState);
      
      return {
        success: true,
        message: `Bot do usuário ${user.username} recuperado com sucesso`
      };
    } catch (error) {
      logger.error(`Erro na recuperação forçada do usuário ${userId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}