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
        await this.sleep(1000);
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
      logger.info(`🔄 Recuperando bot do usuário: ${username} (ID: ${userId})`);
      
      // Verificar se o usuário ainda está aprovado
      const currentUser = await this.db.getUserById(userId);
      if (!currentUser || !currentUser.approved) {
        logger.warn(`❌ Usuário ${username} não está mais aprovado, pulando recuperação`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        return;
      }
      
      // Carregar configurações do usuário
      const userConfig = await this.db.getUserBotConfig(userId);
      if (!userConfig) {
        logger.warn(`❌ Configurações não encontradas para usuário ${username}, pulando...`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        return;
      }
      
      // Verificar credenciais da API
      if (!userConfig.apiKey || !userConfig.apiSecret) {
        logger.warn(`❌ Credenciais da API não encontradas para usuário ${username}, marcando como parado`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        return;
      }
      
      // Carregar estado anterior do bot
      const previousState = await this.stateManager.loadBotState(userId);
      
      if (!this.stateManager.isValidStateForRecovery(previousState)) {
        logger.warn(`❌ Estado inválido para recuperação do usuário ${username}`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        return;
      }
      
      // Importar classes necessárias dinamicamente
      const { TradingBot, TradingConfig, BinanceAPI, BalanceManager } = await this.importTradingClasses();
      
      // Criar configuração específica do usuário
      const config = new TradingConfig();
      config.updateFromDatabase(userConfig);
      
      // Validar configurações
      try {
        config.validate();
      } catch (validationError) {
        logger.warn(`❌ Configurações inválidas para usuário ${username}: ${validationError.message}`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        this.recoveryResults.errors.push(`${username}: ${validationError.message}`);
        return;
      }
      
      // Testar conexão com a API antes de iniciar
      const testApi = new BinanceAPI(config);
      const connectionTest = await testApi.testConnection();
      if (!connectionTest) {
        logger.warn(`❌ Falha na conexão com API Binance para usuário ${username}, marcando como parado`);
        await this.stateManager.setBotRunning(userId, false);
        this.recoveryResults.failed++;
        this.recoveryResults.errors.push(`${username}: Falha na API Binance`);
        return;
      }
      
      // Criar instâncias específicas do usuário
      const userBot = new TradingBot(config, this.db, userId);
      const userApi = new BinanceAPI(config);
      const userBalanceManager = new BalanceManager(this.db, userApi, userId);
      
      // Inicializar mapas globais se não existirem
      if (!global.userBots) global.userBots = new Map();
      if (!global.userBalanceManagers) global.userBalanceManagers = new Map();
      
      // Armazenar instâncias do usuário
      global.userBots.set(userId, userBot);
      global.userBalanceManagers.set(userId, userBalanceManager);
      
      // Configurar callbacks para WebSocket
      this.setupBotCallbacks(userBot, userId);
      
      // Restaurar estado anterior se válido
      if (previousState && previousState.priceHistory) {
        userBot.restoreState(previousState);
        logger.info(`📊 Estado anterior restaurado para usuário ${username}`);
      }
      
      // Iniciar bot do usuário
      await userBot.start();
      
      this.recoveryResults.successful++;
      if (previousState && this.stateManager.isValidStateForRecovery(previousState)) {
      }
      
    } catch (error) {
      this.recoveryResults.failed++;
      this.recoveryResults.errors.push(`${username}: ${error.message}`);
      logger.error(`❌ Erro ao recuperar bot do usuário ${userId} (${username}):`, error.message);
      
      // Marcar como parado em caso de erro
      try {
        await this.stateManager.setBotRunning(userId, false);
      } catch (dbError) {
        logger.error(`Erro ao marcar bot como parado para usuário ${userId}:`, dbError);
      }
    }
  }

  /**
   * Configurar callbacks do bot para WebSocket
   */
  setupBotCallbacks(userBot, userId) {
    userBot.onStatusUpdate = (status) => {
      global.broadcastToUser?.(userId, {
        type: 'status',
        data: status
      });
    };
    
    userBot.onLogMessage = (logEntry) => {
      global.broadcastToUser?.(userId, {
        type: 'log',
        data: logEntry
      });
    };
    
    userBot.onCoinsUpdate = (coinsData) => {
      global.broadcastToUser?.(userId, coinsData);
    };
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
    
    while (waitTime < maxWaitTime) {
      // Verificar se componentes essenciais estão disponíveis
      if (global.db && global.authManager && global.broadcastToUser) {
        logger.info('✅ Sistema pronto para recuperação');
        return;
      }
      
      await this.sleep(checkInterval);
      waitTime += checkInterval;
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