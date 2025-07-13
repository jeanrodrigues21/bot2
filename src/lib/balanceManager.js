import logger from './logger.js';

export default class BalanceManager {
  constructor(database, binanceApi, userId = null) {
    this.db = database;
    this.api = binanceApi;
    this.userId = userId; // ID do usuário específico
    this.updateInterval = null;
    this.isUpdating = false;
  }

  // Iniciar atualizações automáticas de saldo
  startAutoUpdate(intervalMinutes = 5) {
    if (this.updateInterval) {
      this.stopAutoUpdate();
    }

    logger.info(`Iniciando atualizações automáticas de saldo a cada ${intervalMinutes} minutos`);
    
    // Primeira atualização imediata
    this.updateProductionBalance();
    
    // Configurar intervalo
    this.updateInterval = setInterval(() => {
      this.updateProductionBalance();
    }, intervalMinutes * 60 * 1000);
  }

  // Parar atualizações automáticas
  stopAutoUpdate() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info('Atualizações automáticas de saldo paradas');
    }
  }

  // Atualizar saldo de produção via API
  async updateProductionBalance() {
    if (this.isUpdating) {
      logger.debug('Atualização de saldo já em andamento, pulando...');
      return;
    }

    this.isUpdating = true;
    
    try {
      const userInfo = this.userId ? ` para usuário ${this.userId}` : '';
      logger.debug(`Atualizando saldo de produção via API${userInfo}...`);
      
      const usdtBalance = await this.api.getAssetBalance('USDT');
      const btcBalance = await this.api.getBtcBalance();
      
      if (this.userId) {
        await this.db.updateUserBalance(this.userId, usdtBalance, btcBalance);
      } else {
        await this.db.updateBalance(false, usdtBalance, btcBalance);
      }
      
      logger.info(`Saldo de produção atualizado${userInfo}: USDT=${usdtBalance.toFixed(2)}, BTC=${btcBalance.toFixed(8)}`);
      
      return { usdtBalance, btcBalance };
    } catch (error) {
      const userInfo = this.userId ? ` do usuário ${this.userId}` : '';
      logger.error(`Erro ao atualizar saldo de produção${userInfo}:`, error);
      throw error;
    } finally {
      this.isUpdating = false;
    }
  }

  // Forçar atualização manual do saldo
  async forceUpdateBalance() {
    try {
      return await this.updateProductionBalance();
    } catch (error) {
      logger.error('Erro na atualização forçada de saldo:', error);
      throw error;
    }
  }

  // Obter saldo atual do banco (sempre produção)
  async getCurrentBalance() {
    try {
      if (this.userId) {
        return await this.db.getUserBalance(this.userId);
      } else {
        return await this.db.getBalance(false); // Sempre produção
      }
    } catch (error) {
      const userInfo = this.userId ? ` do usuário ${this.userId}` : '';
      logger.error(`Erro ao obter saldo atual${userInfo}:`, error);
      throw error;
    }
  }

  // Verificar se há saldo suficiente para um trade
  async checkSufficientBalance(tradeAmountUsdt) {
    try {
      const balance = await this.getCurrentBalance();
      
      if (balance.usdtBalance >= tradeAmountUsdt) {
        return { sufficient: true, balance };
      } else {
        return { 
          sufficient: false, 
          balance,
          required: tradeAmountUsdt,
          missing: tradeAmountUsdt - balance.usdtBalance
        };
      }
    } catch (error) {
      logger.error('Erro ao verificar saldo suficiente:', error);
      return { sufficient: false, balance: null };
    }
  }

  // Cleanup ao parar o bot
  destroy() {
    this.stopAutoUpdate();
  }
}