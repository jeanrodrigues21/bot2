import logger from '../logger.js';

/**
 * Módulo de Gerenciamento de Estado do Bot
 * 
 * Responsável por salvar e recuperar o estado dos bots,
 * garantindo que sejam reiniciados automaticamente após reinicialização do sistema.
 */
export default class BotStateManager {
  constructor(database) {
    this.db = database;
  }

  /**
   * Salvar estado completo do bot
   */
  async saveBotState(userId, botState) {
    try {
      const stateData = {
        userId: userId,
        isRunning: botState.isRunning,
        currentPrice: botState.currentPrice || 0,
        dailyLow: botState.dailyLow || 0,
        dailyHigh: botState.dailyHigh || 0,
        dailyTrades: botState.dailyTrades || 0,
        totalProfit: botState.totalProfit || 0,
        activeCoin: botState.activeCoin || '-',
        lastBuyTime: botState.lastBuyTime,
        priceHistory: JSON.stringify(botState.priceHistory || []),
        positions: JSON.stringify(botState.positions || []),
        lastUpdate: new Date().toISOString()
      };

      await this.db.saveBotState(userId, stateData);
      logger.debug(`Estado do bot salvo para usuário ${userId}`);
      
    } catch (error) {
      logger.error(`Erro ao salvar estado do bot para usuário ${userId}:`, error);
    }
  }

  /**
   * Recuperar estado do bot
   */
  async loadBotState(userId) {
    try {
      const stateData = await this.db.getBotState(userId);
      
      if (!stateData) {
        return this.getDefaultBotState();
      }

      return {
        isRunning: stateData.isRunning || false,
        currentPrice: stateData.currentPrice || 0,
        dailyLow: stateData.dailyLow || 0,
        dailyHigh: stateData.dailyHigh || 0,
        dailyTrades: stateData.dailyTrades || 0,
        totalProfit: stateData.totalProfit || 0,
        activeCoin: stateData.activeCoin || '-',
        lastBuyTime: stateData.lastBuyTime ? new Date(stateData.lastBuyTime) : null,
        priceHistory: this.parseJsonSafely(stateData.priceHistory, []),
        positions: this.parseJsonSafely(stateData.positions, []),
        lastUpdate: stateData.lastUpdate ? new Date(stateData.lastUpdate) : new Date()
      };
      
    } catch (error) {
      logger.error(`Erro ao carregar estado do bot para usuário ${userId}:`, error);
      return this.getDefaultBotState();
    }
  }

  /**
   * Obter estado padrão do bot
   */
  getDefaultBotState() {
    return {
      isRunning: false,
      currentPrice: 0,
      dailyLow: 0,
      dailyHigh: 0,
      dailyTrades: 0,
      totalProfit: 0,
      activeCoin: '-',
      lastBuyTime: null,
      priceHistory: [],
      positions: [],
      lastUpdate: new Date()
    };
  }

  /**
   * Marcar bot como rodando
   */
  async setBotRunning(userId, isRunning = true) {
    try {
      await this.db.setUserBotRunningState(userId, isRunning);
      logger.info(`Bot do usuário ${userId} marcado como ${isRunning ? 'rodando' : 'parado'}`);
    } catch (error) {
      logger.error(`Erro ao marcar estado do bot para usuário ${userId}:`, error);
    }
  }

  /**
   * Obter todos os usuários com bots rodando
   */
  async getRunningBots() {
    try {
      return await this.db.getRunningUserBots();
    } catch (error) {
      logger.error('Erro ao obter bots rodando:', error);
      return [];
    }
  }

  /**
   * Limpar estados antigos (manutenção)
   */
  async cleanOldStates(daysOld = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysOld);
      
      await this.db.cleanOldBotStates(cutoffDate.toISOString());
      logger.info(`Estados antigos limpos (mais de ${daysOld} dias)`);
    } catch (error) {
      logger.error('Erro ao limpar estados antigos:', error);
    }
  }

  /**
   * Salvar checkpoint do estado (para recuperação rápida)
   */
  async saveCheckpoint(userId, botInstance) {
    try {
      const checkpoint = {
        timestamp: new Date().toISOString(),
        isRunning: botInstance.isRunning,
        currentPrice: botInstance.currentPrice,
        dailyLow: botInstance.dailyLow,
        dailyHigh: botInstance.dailyHigh,
        dailyTrades: botInstance.dailyTrades,
        totalProfit: botInstance.totalProfit,
        activeCoin: botInstance.activeCoin,
        positionsCount: botInstance.positions ? botInstance.positions.length : 0
      };

      await this.saveBotState(userId, checkpoint);
      logger.debug(`Checkpoint salvo para usuário ${userId}`);
      
    } catch (error) {
      logger.error(`Erro ao salvar checkpoint para usuário ${userId}:`, error);
    }
  }

  /**
   * Verificar se o estado é válido para recuperação
   */
  isValidStateForRecovery(state) {
    if (!state) return false;
    
    // Verificar se o estado não é muito antigo (mais de 24 horas)
    if (state.lastUpdate) {
      const hoursSinceUpdate = (Date.now() - new Date(state.lastUpdate).getTime()) / (1000 * 60 * 60);
      if (hoursSinceUpdate > 24) {
        logger.warn('Estado muito antigo para recuperação automática');
        return false;
      }
    }
    
    return true;
  }

  /**
   * Parse JSON com tratamento de erro
   */
  parseJsonSafely(jsonString, defaultValue = null) {
    try {
      if (!jsonString) return defaultValue;
      return JSON.parse(jsonString);
    } catch (error) {
      logger.warn('Erro ao fazer parse de JSON, usando valor padrão:', error.message);
      return defaultValue;
    }
  }

  /**
   * Obter estatísticas dos estados salvos
   */
  async getStateStatistics() {
    try {
      const runningBots = await this.getRunningBots();
      
      return {
        totalRunningBots: runningBots.length,
        runningUsers: runningBots.map(bot => ({
          userId: bot.user_id,
          username: bot.username,
          lastUpdate: bot.last_update
        }))
      };
    } catch (error) {
      logger.error('Erro ao obter estatísticas de estado:', error);
      return { totalRunningBots: 0, runningUsers: [] };
    }
  }
}