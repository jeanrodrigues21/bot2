import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class Database {
  constructor() {
    this.db = null;
    this.dbPath = path.join(__dirname, '../../data/trading_bot.db');
  }

  async init() {
    try {
      // Criar diretório data se não existir
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Abrir conexão com o banco
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // Habilitar foreign keys
      await this.db.exec('PRAGMA foreign_keys = ON');

      // Criar tabelas
      await this.createTables();

      // Criar usuário admin padrão
      await this.createDefaultAdmin();

      logger.info('Database inicializado com sucesso');
    } catch (error) {
      logger.error('Erro ao inicializar database:', error);
      throw error;
    }
  }

  async createTables() {
    try {
      // Tabela de usuários
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT DEFAULT 'user',
          approved INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_access DATETIME,
          access_count INTEGER DEFAULT 0
        )
      `);

      // Tabela de sessões
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          token TEXT UNIQUE NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      // Tabela de configurações do bot por usuário
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_bot_configs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          symbol TEXT DEFAULT 'BTCUSDT',
          trade_amount_usdt REAL DEFAULT 100.0,
          trade_amount_percent REAL DEFAULT 10.0,
          min_trade_amount_usdt REAL DEFAULT 5.0,
          max_trade_amount_usdt REAL DEFAULT 10000.0,
          daily_profit_target REAL DEFAULT 1.0,
          stop_loss_percent REAL DEFAULT 2.0,
          max_daily_trades INTEGER DEFAULT 10,
          min_price_change REAL DEFAULT 0.5,
          trading_mode TEXT DEFAULT 'single',
          dynamic_coins TEXT DEFAULT '["BTCUSDT","ETHUSDT","BNBUSDT","ADAUSDT","SOLUSDT"]',
          original_strategy_percent REAL DEFAULT 70.0,
          reinforcement_strategy_percent REAL DEFAULT 30.0,
          reinforcement_trigger_percent REAL DEFAULT 1.0,
          enable_reinforcement INTEGER DEFAULT 1,
          api_key TEXT,
          api_secret TEXT,
          base_url TEXT DEFAULT 'https://api.binance.com',
          buy_threshold_from_low REAL DEFAULT 0.2,
          min_history_for_analysis INTEGER DEFAULT 20,
          recent_trend_window INTEGER DEFAULT 10,
          buy_cooldown_seconds INTEGER DEFAULT 300,
          price_poll_interval INTEGER DEFAULT 10,
          log_frequency INTEGER DEFAULT 60,
          maker_fee REAL DEFAULT 0.001,
          taker_fee REAL DEFAULT 0.001,
          buy_on_drop_percent REAL DEFAULT 0.7,
          test_mode INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      // Tabela de estado dos bots por usuário
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_bot_states (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          is_running INTEGER DEFAULT 0,
          current_price REAL DEFAULT 0,
          daily_low REAL DEFAULT 0,
          daily_high REAL DEFAULT 0,
          daily_trades INTEGER DEFAULT 0,
          total_profit REAL DEFAULT 0,
          active_coin TEXT DEFAULT '-',
          last_buy_time DATETIME,
          price_history TEXT DEFAULT '[]',
          positions TEXT DEFAULT '[]',
          last_update DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      // Tabela de saldos por usuário
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_balances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          usdt_balance REAL DEFAULT 0,
          btc_balance REAL DEFAULT 0,
          test_mode INTEGER DEFAULT 0,
          last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      // Tabela de histórico de trades por usuário
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          side TEXT NOT NULL,
          quantity REAL NOT NULL,
          price REAL NOT NULL,
          amount REAL NOT NULL,
          profit REAL DEFAULT 0,
          strategy_type TEXT DEFAULT 'original',
          order_id TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      // Tabela de posições abertas por usuário
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_positions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          symbol TEXT NOT NULL,
          order_id TEXT NOT NULL,
          buy_price REAL NOT NULL,
          quantity REAL NOT NULL,
          strategy_type TEXT DEFAULT 'original',
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
        )
      `);

      // Tabela de histórico de preços (compartilhada)
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS price_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          symbol TEXT NOT NULL,
          price REAL NOT NULL,
          daily_low REAL DEFAULT 0,
          daily_high REAL DEFAULT 0,
          volume_24h REAL DEFAULT 0,
          price_change_24h REAL DEFAULT 0,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Tabela de estatísticas diárias por usuário
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS user_daily_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          date DATE NOT NULL,
          trades_count INTEGER DEFAULT 0,
          total_profit REAL DEFAULT 0,
          total_volume REAL DEFAULT 0,
          success_rate REAL DEFAULT 0,
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
          UNIQUE(user_id, date)
        )
      `);

      // Criar índices para performance
      await this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_bot_configs_user_id ON user_bot_configs(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_bot_states_user_id ON user_bot_states(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_balances_user_id ON user_balances(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_trades_user_id ON user_trades(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_positions_user_id ON user_positions(user_id);
        CREATE INDEX IF NOT EXISTS idx_price_history_symbol ON price_history(symbol);
        CREATE INDEX IF NOT EXISTS idx_price_history_timestamp ON price_history(timestamp);
        CREATE INDEX IF NOT EXISTS idx_user_daily_stats_user_date ON user_daily_stats(user_id, date);
      `);

      logger.info('Tabelas do banco de dados criadas/verificadas com sucesso');
    } catch (error) {
      logger.error('Erro ao criar tabelas:', error);
      throw error;
    }
  }

  async createDefaultAdmin() {
    try {
      const existingAdmin = await this.db.get(
        'SELECT id FROM users WHERE username = ? OR role = ?',
        ['jean', 'admin']
      );

      if (!existingAdmin) {
        const bcrypt = await import('bcryptjs');
        const hashedPassword = await bcrypt.default.hash('123456', 12);

        const result = await this.db.run(`
          INSERT INTO users (username, email, password, role, approved)
          VALUES (?, ?, ?, ?, ?)
        `, ['jean', 'jean@trading.com', hashedPassword, 'admin', 1]);

        // Criar configuração padrão para o admin
        await this.createUserBotConfig(result.lastID);
        await this.createUserBalance(result.lastID);
        await this.createUserBotState(result.lastID);

        logger.info('Usuário admin padrão criado: jean / 123456');
      }
    } catch (error) {
      logger.error('Erro ao criar admin padrão:', error);
    }
  }

  // ==================== MÉTODOS DE USUÁRIOS ====================

  async createUser(userData) {
    try {
      const result = await this.db.run(`
        INSERT INTO users (username, email, password, role, approved)
        VALUES (?, ?, ?, ?, ?)
      `, [userData.username, userData.email, userData.password, userData.role || 'user', userData.approved ? 1 : 0]);

      const userId = result.lastID;

      // Criar configuração padrão
      await this.createUserBotConfig(userId);
      await this.createUserBalance(userId);
      await this.createUserBotState(userId);

      return userId;
    } catch (error) {
      logger.error('Erro ao criar usuário:', error);
      throw error;
    }
  }

  async getUserById(id) {
    return await this.db.get('SELECT * FROM users WHERE id = ?', [id]);
  }

  async getUserByUsername(username) {
    return await this.db.get('SELECT * FROM users WHERE username = ?', [username]);
  }

  async getUserByUsernameOrEmail(username, email) {
    return await this.db.get(
      'SELECT * FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
  }

  async getAllUsers() {
    return await this.db.all('SELECT * FROM users ORDER BY created_at DESC');
  }

  async getPendingUsers() {
    return await this.db.all('SELECT * FROM users WHERE approved = 0 ORDER BY created_at ASC');
  }

  async getActiveUsers() {
    return await this.db.all(`
      SELECT u.*, s.created_at as session_start
      FROM users u
      INNER JOIN sessions s ON u.id = s.user_id
      WHERE u.approved = 1
      ORDER BY s.created_at DESC
    `);
  }

  async updateUser(userId, updates) {
    const fields = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = Object.values(updates);
    values.push(userId);

    return await this.db.run(
      `UPDATE users SET ${fields} WHERE id = ?`,
      values
    );
  }

  async deleteUser(userId) {
    return await this.db.run('DELETE FROM users WHERE id = ?', [userId]);
  }

  async approveUser(userId) {
    return await this.db.run('UPDATE users SET approved = 1 WHERE id = ?', [userId]);
  }

  async updateUserLastAccess(userId) {
    return await this.db.run(
      'UPDATE users SET last_access = CURRENT_TIMESTAMP, access_count = access_count + 1 WHERE id = ?',
      [userId]
    );
  }

  // ==================== MÉTODOS DE SESSÕES ====================

  async createSession(userId, token) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
    return await this.db.run(`
      INSERT INTO sessions (user_id, token, expires_at)
      VALUES (?, ?, ?)
    `, [userId, token, expiresAt.toISOString()]);
  }

  async getSession(token) {
    return await this.db.get('SELECT * FROM sessions WHERE token = ?', [token]);
  }

  async deleteSession(token) {
    return await this.db.run('DELETE FROM sessions WHERE token = ?', [token]);
  }

  async deleteUserSessions(userId) {
    return await this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
  }

  async deleteExpiredSessions(sessionTimeout) {
    const cutoff = new Date(Date.now() - sessionTimeout);
    const result = await this.db.run(
      'DELETE FROM sessions WHERE created_at < ?',
      [cutoff.toISOString()]
    );
    return result.changes;
  }

  // ==================== MÉTODOS DE CONFIGURAÇÃO DO BOT ====================

  async createUserBotConfig(userId) {
    try {
      return await this.db.run(`
        INSERT INTO user_bot_configs (user_id) VALUES (?)
      `, [userId]);
    } catch (error) {
      logger.error(`Erro ao criar configuração para usuário ${userId}:`, error);
      throw error;
    }
  }

  async getUserBotConfig(userId) {
    try {
      const config = await this.db.get(
        'SELECT * FROM user_bot_configs WHERE user_id = ?',
        [userId]
      );

      if (!config) {
        await this.createUserBotConfig(userId);
        return await this.getUserBotConfig(userId);
      }

      // Converter campos JSON
      if (config.dynamic_coins) {
        try {
          config.dynamicCoins = JSON.parse(config.dynamic_coins);
        } catch (e) {
          config.dynamicCoins = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
        }
      }

      // Converter campos boolean
      config.enableReinforcement = Boolean(config.enable_reinforcement);
      config.testMode = Boolean(config.test_mode);

      return config;
    } catch (error) {
      logger.error(`Erro ao obter configuração do usuário ${userId}:`, error);
      throw error;
    }
  }

  async saveUserBotConfig(userId, config) {
    try {
      // Converter arrays para JSON
      const dynamicCoins = Array.isArray(config.dynamicCoins) ? 
        JSON.stringify(config.dynamicCoins) : 
        JSON.stringify(['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);

      return await this.db.run(`
        UPDATE user_bot_configs SET
          symbol = ?,
          trade_amount_usdt = ?,
          trade_amount_percent = ?,
          min_trade_amount_usdt = ?,
          max_trade_amount_usdt = ?,
          daily_profit_target = ?,
          stop_loss_percent = ?,
          max_daily_trades = ?,
          min_price_change = ?,
          trading_mode = ?,
          dynamic_coins = ?,
          original_strategy_percent = ?,
          reinforcement_strategy_percent = ?,
          reinforcement_trigger_percent = ?,
          enable_reinforcement = ?,
          api_key = ?,
          api_secret = ?,
          base_url = ?,
          buy_threshold_from_low = ?,
          min_history_for_analysis = ?,
          recent_trend_window = ?,
          buy_cooldown_seconds = ?,
          price_poll_interval = ?,
          log_frequency = ?,
          maker_fee = ?,
          taker_fee = ?,
          buy_on_drop_percent = ?,
          test_mode = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `, [
        config.symbol || 'BTCUSDT',
        config.tradeAmountUsdt || 100,
        config.tradeAmountPercent || 10.0,
        config.minTradeAmountUsdt || 5.0,
        config.maxTradeAmountUsdt || 10000.0,
        config.dailyProfitTarget || 1.0,
        config.stopLossPercent || 2.0,
        config.maxDailyTrades || 10,
        config.minPriceChange || 0.5,
        config.tradingMode || 'single',
        dynamicCoins,
        config.originalStrategyPercent || 70.0,
        config.reinforcementStrategyPercent || 30.0,
        config.reinforcementTriggerPercent || 1.0,
        config.enableReinforcement ? 1 : 0,
        config.apiKey || '',
        config.apiSecret || '',
        config.baseUrl || 'https://api.binance.com',
        config.buyThresholdFromLow || 0.2,
        config.minHistoryForAnalysis || 20,
        config.recentTrendWindow || 10,
        config.buyCooldownSeconds || 300,
        config.pricePollInterval || 10,
        config.logFrequency || 60,
        config.makerFee || 0.001,
        config.takerFee || 0.001,
        config.buyOnDropPercent || 0.7,
        config.testMode ? 1 : 0,
        userId
      ]);
    } catch (error) {
      logger.error(`Erro ao salvar configuração do usuário ${userId}:`, error);
      throw error;
    }
  }

  // ==================== MÉTODOS DE ESTADO DO BOT ====================

  async createUserBotState(userId) {
    try {
      return await this.db.run(`
        INSERT INTO user_bot_states (user_id) VALUES (?)
      `, [userId]);
    } catch (error) {
      logger.error(`Erro ao criar estado para usuário ${userId}:`, error);
      throw error;
    }
  }

  async getUserBotState(userId) {
    try {
      const state = await this.db.get(
        'SELECT * FROM user_bot_states WHERE user_id = ?',
        [userId]
      );

      if (!state) {
        await this.createUserBotState(userId);
        return await this.getUserBotState(userId);
      }

      return state;
    } catch (error) {
      logger.error(`Erro ao obter estado do usuário ${userId}:`, error);
      throw error;
    }
  }

  async setUserBotRunningState(userId, isRunning) {
    try {
      return await this.db.run(`
        UPDATE user_bot_states SET 
          is_running = ?,
          last_update = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `, [isRunning ? 1 : 0, userId]);
    } catch (error) {
      logger.error(`Erro ao definir estado de execução do usuário ${userId}:`, error);
      throw error;
    }
  }

  async saveBotState(userId, stateData) {
    try {
      return await this.db.run(`
        UPDATE user_bot_states SET
          is_running = ?,
          current_price = ?,
          daily_low = ?,
          daily_high = ?,
          daily_trades = ?,
          total_profit = ?,
          active_coin = ?,
          last_buy_time = ?,
          price_history = ?,
          positions = ?,
          last_update = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `, [
        stateData.isRunning ? 1 : 0,
        stateData.currentPrice || 0,
        stateData.dailyLow || 0,
        stateData.dailyHigh || 0,
        stateData.dailyTrades || 0,
        stateData.totalProfit || 0,
        stateData.activeCoin || '-',
        stateData.lastBuyTime,
        stateData.priceHistory || '[]',
        stateData.positions || '[]',
        userId
      ]);
    } catch (error) {
      logger.error(`Erro ao salvar estado do bot para usuário ${userId}:`, error);
      throw error;
    }
  }

  async getBotState(userId) {
    try {
      const state = await this.db.get(
        'SELECT * FROM user_bot_states WHERE user_id = ?',
        [userId]
      );

      if (state) {
        // Parse JSON fields
        try {
          state.priceHistory = JSON.parse(state.price_history || '[]');
        } catch (e) {
          state.priceHistory = [];
        }

        try {
          state.positions = JSON.parse(state.positions || '[]');
        } catch (e) {
          state.positions = [];
        }

        state.isRunning = Boolean(state.is_running);
      }

      return state;
    } catch (error) {
      logger.error(`Erro ao obter estado do bot para usuário ${userId}:`, error);
      throw error;
    }
  }

  async getRunningUserBots() {
    try {
      return await this.db.all(`
        SELECT u.id as user_id, u.username, s.last_update
        FROM users u
        INNER JOIN user_bot_states s ON u.id = s.user_id
        WHERE u.approved = 1 AND s.is_running = 1
        ORDER BY s.last_update DESC
      `);
    } catch (error) {
      logger.error('Erro ao obter bots em execução:', error);
      return [];
    }
  }

  async cleanOldBotStates(cutoffDate) {
    try {
      return await this.db.run(
        'DELETE FROM user_bot_states WHERE last_update < ? AND is_running = 0',
        [cutoffDate]
      );
    } catch (error) {
      logger.error('Erro ao limpar estados antigos:', error);
      throw error;
    }
  }

  // ==================== MÉTODOS DE SALDO ====================

  async createUserBalance(userId) {
    try {
      return await this.db.run(`
        INSERT INTO user_balances (user_id) VALUES (?)
      `, [userId]);
    } catch (error) {
      logger.error(`Erro ao criar saldo para usuário ${userId}:`, error);
      throw error;
    }
  }

  async getUserBalance(userId) {
    try {
      const balance = await this.db.get(
        'SELECT * FROM user_balances WHERE user_id = ?',
        [userId]
      );

      if (!balance) {
        await this.createUserBalance(userId);
        return await this.getUserBalance(userId);
      }

      return {
        usdtBalance: balance.usdt_balance || 0,
        btcBalance: balance.btc_balance || 0,
        lastUpdated: balance.last_updated
      };
    } catch (error) {
      logger.error(`Erro ao obter saldo do usuário ${userId}:`, error);
      throw error;
    }
  }

  async updateUserBalance(userId, usdtBalance, btcBalance) {
    try {
      return await this.db.run(`
        UPDATE user_balances SET
          usdt_balance = ?,
          btc_balance = ?,
          last_updated = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `, [usdtBalance, btcBalance, userId]);
    } catch (error) {
      logger.error(`Erro ao atualizar saldo do usuário ${userId}:`, error);
      throw error;
    }
  }

  // ==================== MÉTODOS DE TRADES ====================

  async saveUserTrade(userId, tradeData) {
    try {
      return await this.db.run(`
        INSERT INTO user_trades (
          user_id, symbol, side, quantity, price, amount, profit, strategy_type, order_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        tradeData.symbol,
        tradeData.side,
        tradeData.quantity,
        tradeData.price,
        tradeData.amount,
        tradeData.profit || 0,
        tradeData.strategyType || 'original',
        tradeData.orderId
      ]);
    } catch (error) {
      logger.error(`Erro ao salvar trade do usuário ${userId}:`, error);
      throw error;
    }
  }

  async getUserTradeHistory(userId, limit = 50) {
    try {
      return await this.db.all(`
        SELECT * FROM user_trades 
        WHERE user_id = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `, [userId, limit]);
    } catch (error) {
      logger.error(`Erro ao obter histórico de trades do usuário ${userId}:`, error);
      return [];
    }
  }

  // ==================== MÉTODOS DE POSIÇÕES ====================

  async saveUserPosition(userId, positionData) {
    try {
      return await this.db.run(`
        INSERT INTO user_positions (
          user_id, symbol, order_id, buy_price, quantity, strategy_type
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        userId,
        positionData.symbol,
        positionData.orderId,
        positionData.buyPrice,
        positionData.quantity,
        positionData.strategyType || 'original'
      ]);
    } catch (error) {
      logger.error(`Erro ao salvar posição do usuário ${userId}:`, error);
      throw error;
    }
  }

  async getUserOpenPositions(userId) {
    try {
      return await this.db.all(
        'SELECT * FROM user_positions WHERE user_id = ? ORDER BY timestamp DESC',
        [userId]
      );
    } catch (error) {
      logger.error(`Erro ao obter posições do usuário ${userId}:`, error);
      return [];
    }
  }

  async closeUserPosition(userId, orderId, sellPrice, profit) {
    try {
      // Salvar trade de venda
      const position = await this.db.get(
        'SELECT * FROM user_positions WHERE user_id = ? AND order_id = ?',
        [userId, orderId]
      );

      if (position) {
        await this.saveUserTrade(userId, {
          symbol: position.symbol,
          side: 'SELL',
          quantity: position.quantity,
          price: sellPrice,
          amount: sellPrice * position.quantity,
          profit: profit,
          strategyType: position.strategy_type,
          orderId: orderId
        });
      }

      // Remover posição
      return await this.db.run(
        'DELETE FROM user_positions WHERE user_id = ? AND order_id = ?',
        [userId, orderId]
      );
    } catch (error) {
      logger.error(`Erro ao fechar posição do usuário ${userId}:`, error);
      throw error;
    }
  }

  // ==================== MÉTODOS DE HISTÓRICO DE PREÇOS ====================

  async savePricePoint(symbol, priceData) {
    try {
      return await this.db.run(`
        INSERT INTO price_history (symbol, price, daily_low, daily_high, volume_24h, price_change_24h)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        symbol,
        priceData.price,
        priceData.dailyLow || 0,
        priceData.dailyHigh || 0,
        priceData.volume24h || 0,
        priceData.priceChange24h || 0
      ]);
    } catch (error) {
      logger.error(`Erro ao salvar ponto de preço para ${symbol}:`, error);
      throw error;
    }
  }

  async saveMultiPricePoint(symbol, priceData) {
    return await this.savePricePoint(symbol, priceData);
  }

  async getPriceHistory(symbol, hours = 24) {
    try {
      const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
      return await this.db.all(`
        SELECT * FROM price_history 
        WHERE symbol = ? AND timestamp > ?
        ORDER BY timestamp ASC
      `, [symbol, cutoff.toISOString()]);
    } catch (error) {
      logger.error(`Erro ao obter histórico de preços para ${symbol}:`, error);
      return [];
    }
  }

  // ==================== MÉTODOS DE ESTATÍSTICAS ====================

  async getUserDailyStats(userId, days = 30) {
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      return await this.db.all(`
        SELECT * FROM user_daily_stats 
        WHERE user_id = ? AND date > ?
        ORDER BY date DESC
      `, [userId, cutoff.toISOString().split('T')[0]]);
    } catch (error) {
      logger.error(`Erro ao obter estatísticas do usuário ${userId}:`, error);
      return [];
    }
  }

  async updateUserDailyStats(userId, date, stats) {
    try {
      return await this.db.run(`
        INSERT OR REPLACE INTO user_daily_stats (
          user_id, date, trades_count, total_profit, total_volume, success_rate
        ) VALUES (?, ?, ?, ?, ?, ?)
      `, [
        userId,
        date,
        stats.tradesCount || 0,
        stats.totalProfit || 0,
        stats.totalVolume || 0,
        stats.successRate || 0
      ]);
    } catch (error) {
      logger.error(`Erro ao atualizar estatísticas diárias do usuário ${userId}:`, error);
      throw error;
    }
  }

  // ==================== MÉTODOS LEGADOS (COMPATIBILIDADE) ====================

  async getBotConfig() {
    // Método legado - retorna configuração do admin para compatibilidade
    try {
      const adminUser = await this.db.get('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      if (adminUser) {
        return await this.getUserBotConfig(adminUser.id);
      }
      return null;
    } catch (error) {
      logger.error('Erro ao obter configuração legada:', error);
      return null;
    }
  }

  async updateBotConfigFields(config) {
    // Método legado - atualiza configuração do admin para compatibilidade
    try {
      const adminUser = await this.db.get('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      if (adminUser) {
        return await this.saveUserBotConfig(adminUser.id, config);
      }
    } catch (error) {
      logger.error('Erro ao atualizar configuração legada:', error);
      throw error;
    }
  }

  async setBotRunningState(isRunning) {
    // Método legado - define estado do admin para compatibilidade
    try {
      const adminUser = await this.db.get('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      if (adminUser) {
        return await this.setUserBotRunningState(adminUser.id, isRunning);
      }
    } catch (error) {
      logger.error('Erro ao definir estado legado:', error);
      throw error;
    }
  }

  async getBalance(testMode = false) {
    // Método legado - retorna saldo do admin para compatibilidade
    try {
      const adminUser = await this.db.get('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      if (adminUser) {
        return await this.getUserBalance(adminUser.id);
      }
      return { usdtBalance: 0, btcBalance: 0, lastUpdated: new Date() };
    } catch (error) {
      logger.error('Erro ao obter saldo legado:', error);
      return { usdtBalance: 0, btcBalance: 0, lastUpdated: new Date() };
    }
  }

  async updateBalance(testMode, usdtBalance, btcBalance) {
    // Método legado - atualiza saldo do admin para compatibilidade
    try {
      const adminUser = await this.db.get('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin']);
      if (adminUser) {
        return await this.updateUserBalance(adminUser.id, usdtBalance, btcBalance);
      }
    } catch (error) {
      logger.error('Erro ao atualizar saldo legado:', error);
      throw error;
    }
  }

  // ==================== MÉTODO DE CONSULTA GENÉRICA ====================

  async query(sql, params = []) {
    try {
      return await this.db.all(sql, params);
    } catch (error) {
      logger.error('Erro na consulta SQL:', error);
      throw error;
    }
  }

  // ==================== MÉTODO DE FECHAMENTO ====================

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
      logger.info('Conexão com o banco de dados fechada');
    }
  }
}