import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import logger from './logger.js';
import path from 'path';
import fs from 'fs';

export default class Database {
  constructor() {
    this.db = null;
    this.dbPath = path.join(process.cwd(), 'data', 'trading_bot.db');
  }

  async init() {
    try {
      // Criar diretório de dados se não existir
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        logger.info('Diretório de dados criado');
      }

      // Abrir conexão com o banco
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // Criar tabelas
      await this.createTables();
      
      logger.info('Banco de dados inicializado com sucesso');
    } catch (error) {
      logger.error('Erro ao inicializar banco de dados:', error);
      throw error;
    }
  }

  async createTables() {
    // Tabela de usuários
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        approved BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        expires_at DATETIME NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // Tabela de configurações do bot por usuário
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_bot_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        symbol TEXT DEFAULT 'BTCUSDT',
        trade_amount_usdt REAL DEFAULT 100,
        trade_amount_percent REAL DEFAULT 10.0,
        min_trade_amount_usdt REAL DEFAULT 5.0,
        max_trade_amount_usdt REAL DEFAULT 10000.0,
        daily_profit_target REAL DEFAULT 1.0,
        stop_loss_percent REAL DEFAULT 2.0,
        max_daily_trades INTEGER DEFAULT 10,
        min_price_change REAL DEFAULT 0.5,
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
        trading_mode TEXT DEFAULT 'single',
        dynamic_coins TEXT DEFAULT '["BTCUSDT","ETHUSDT","BNBUSDT","ADAUSDT","SOLUSDT","XRPUSDT","DOTUSDT","DOGEUSDT","AVAXUSDT","MATICUSDT"]',
        original_strategy_percent REAL DEFAULT 70,
        reinforcement_strategy_percent REAL DEFAULT 30,
        reinforcement_trigger_percent REAL DEFAULT 1.0,
        enable_reinforcement BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // Tabela de estado do bot por usuário
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_bot_states (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        total_profit REAL DEFAULT 0,
        daily_trades INTEGER DEFAULT 0,
        is_running BOOLEAN DEFAULT 0,
        last_reset_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // Tabela de saldos por usuário
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_account_balances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        usdt_balance REAL DEFAULT 0,
        btc_balance REAL DEFAULT 0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // NOVA TABELA: Posições por usuário com suporte a múltiplas estratégias
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        status TEXT DEFAULT 'OPEN',
        strategy_type TEXT DEFAULT 'original',
        parent_position_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        profit REAL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (parent_position_id) REFERENCES user_positions (id)
      )
    `);

    // NOVA TABELA: Trades por usuário com informações de estratégia
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        fee REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        strategy_type TEXT DEFAULT 'original',
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // NOVA TABELA: Histórico de preços para múltiplas moedas
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS multi_price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        daily_low REAL,
        daily_high REAL,
        volume_24h REAL,
        price_change_24h REAL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create index for multi_price_history table
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_multi_price_history_symbol_timestamp 
      ON multi_price_history (symbol, timestamp)
    `);

    // Manter tabelas globais para compatibilidade (serão migradas)
    await this.createLegacyTables();

    // Verificar e adicionar colunas que podem estar faltando
    await this.addMissingColumns();

    // Criar usuário administrador padrão
    await this.createDefaultAdmin();
  }

  async createLegacyTables() {
    // Tabela de configurações do bot (global - para compatibilidade)
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_config (
        id INTEGER PRIMARY KEY,
        symbol TEXT DEFAULT 'BTCUSDT',
        trade_amount_usdt REAL DEFAULT 100,
        trade_amount_percent REAL DEFAULT 10.0,
        min_trade_amount_usdt REAL DEFAULT 5.0,
        max_trade_amount_usdt REAL DEFAULT 10000.0,
        daily_profit_target REAL DEFAULT 1.0,
        stop_loss_percent REAL DEFAULT 2.0,
        max_daily_trades INTEGER DEFAULT 10,
        min_price_change REAL DEFAULT 0.5,
        test_mode BOOLEAN DEFAULT 0,
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
        check_interval INTEGER DEFAULT 30000,
        profit_percentage REAL DEFAULT 1.5,
        trailing_stop BOOLEAN DEFAULT 0,
        trailing_stop_percent REAL DEFAULT 0.5,
        max_positions INTEGER DEFAULT 3,
        trading_mode TEXT DEFAULT 'single',
        dynamic_coins TEXT DEFAULT '["BTCUSDT","ETHUSDT","BNBUSDT","ADAUSDT","SOLUSDT","XRPUSDT","DOTUSDT","DOGEUSDT","AVAXUSDT","MATICUSDT"]',
        original_strategy_percent REAL DEFAULT 70,
        reinforcement_strategy_percent REAL DEFAULT 30,
        reinforcement_trigger_percent REAL DEFAULT 1.0,
        enable_reinforcement BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Outras tabelas legadas...
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_state (
        id INTEGER PRIMARY KEY,
        total_profit REAL DEFAULT 0,
        daily_trades INTEGER DEFAULT 0,
        is_running BOOLEAN DEFAULT 0,
        last_reset_date TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_balances (
        id INTEGER PRIMARY KEY,
        test_mode BOOLEAN NOT NULL,
        usdt_balance REAL DEFAULT 0,
        btc_balance REAL DEFAULT 0,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT UNIQUE NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        status TEXT DEFAULT 'OPEN',
        strategy_type TEXT DEFAULT 'original',
        parent_position_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        profit REAL DEFAULT 0,
        FOREIGN KEY (parent_position_id) REFERENCES positions (id)
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity REAL NOT NULL,
        price REAL NOT NULL,
        fee REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        strategy_type TEXT DEFAULT 'original',
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        price REAL NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT UNIQUE NOT NULL,
        symbol TEXT NOT NULL,
        trades_count INTEGER DEFAULT 0,
        total_profit REAL DEFAULT 0,
        daily_low REAL,
        daily_high REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async addMissingColumns() {
    try {
      const configTableInfo = await this.db.all("PRAGMA table_info(bot_config)");
      const existingColumns = configTableInfo.map(col => col.name);

      const newColumns = [
        { name: 'trade_amount_usdt', type: 'REAL', default: '100' },
        { name: 'trade_amount_percent', type: 'REAL', default: '10.0' },
        { name: 'min_trade_amount_usdt', type: 'REAL', default: '5.0' },
        { name: 'max_trade_amount_usdt', type: 'REAL', default: '10000.0' },
        { name: 'daily_profit_target', type: 'REAL', default: '1.0' },
        { name: 'stop_loss_percent', type: 'REAL', default: '2.0' },
        { name: 'max_daily_trades', type: 'INTEGER', default: '10' },
        { name: 'min_price_change', type: 'REAL', default: '0.5' },
        { name: 'test_mode', type: 'BOOLEAN', default: '0' },
        { name: 'api_key', type: 'TEXT', default: 'NULL' },
        { name: 'api_secret', type: 'TEXT', default: 'NULL' },
        { name: 'base_url', type: 'TEXT', default: "'https://api.binance.com'" },
        { name: 'buy_threshold_from_low', type: 'REAL', default: '0.2' },
        { name: 'min_history_for_analysis', type: 'INTEGER', default: '20' },
        { name: 'recent_trend_window', type: 'INTEGER', default: '10' },
        { name: 'buy_cooldown_seconds', type: 'INTEGER', default: '300' },
        { name: 'price_poll_interval', type: 'INTEGER', default: '10' },
        { name: 'log_frequency', type: 'INTEGER', default: '60' },
        { name: 'maker_fee', type: 'REAL', default: '0.001' },
        { name: 'taker_fee', type: 'REAL', default: '0.001' },
        { name: 'check_interval', type: 'INTEGER', default: '30000' },
        { name: 'profit_percentage', type: 'REAL', default: '1.5' },
        { name: 'trailing_stop', type: 'BOOLEAN', default: '0' },
        { name: 'trailing_stop_percent', type: 'REAL', default: '0.5' },
        { name: 'max_positions', type: 'INTEGER', default: '3' },
        { name: 'trading_mode', type: 'TEXT', default: "'single'" },
        { name: 'dynamic_coins', type: 'TEXT', default: "'[\"BTCUSDT\",\"ETHUSDT\",\"BNBUSDT\",\"ADAUSDT\",\"SOLUSDT\",\"XRPUSDT\",\"DOTUSDT\",\"DOGEUSDT\",\"AVAXUSDT\",\"MATICUSDT\"]'" },
        { name: 'original_strategy_percent', type: 'REAL', default: '70' },
        { name: 'reinforcement_strategy_percent', type: 'REAL', default: '30' },
        { name: 'reinforcement_trigger_percent', type: 'REAL', default: '1.0' },
        { name: 'enable_reinforcement', type: 'BOOLEAN', default: '1' },
        { name: 'created_at', type: 'DATETIME', default: 'CURRENT_TIMESTAMP' },
        { name: 'updated_at', type: 'DATETIME', default: 'CURRENT_TIMESTAMP' }
      ];

      for (const column of newColumns) {
        if (!existingColumns.includes(column.name)) {
          await this.db.exec(`ALTER TABLE bot_config ADD COLUMN ${column.name} ${column.type} DEFAULT ${column.default}`);
          logger.info(`Coluna ${column.name} adicionada à tabela bot_config`);
        }
      }

      // Verificar se a coluna is_running existe na tabela bot_state
      const stateTableInfo = await this.db.all("PRAGMA table_info(bot_state)");
      const hasIsRunningColumn = stateTableInfo.some(column => column.name === 'is_running');
      
      if (!hasIsRunningColumn) {
        await this.db.exec("ALTER TABLE bot_state ADD COLUMN is_running BOOLEAN DEFAULT 0");
        logger.info('Coluna is_running adicionada à tabela bot_state');
      }

      // Adicionar colunas de estratégia às tabelas de posições e trades se não existirem
      const positionsTableInfo = await this.db.all("PRAGMA table_info(positions)");
      const positionsColumns = positionsTableInfo.map(col => col.name);
      
      if (!positionsColumns.includes('strategy_type')) {
        await this.db.exec("ALTER TABLE positions ADD COLUMN strategy_type TEXT DEFAULT 'original'");
        logger.info('Coluna strategy_type adicionada à tabela positions');
      }
      
      if (!positionsColumns.includes('parent_position_id')) {
        await this.db.exec("ALTER TABLE positions ADD COLUMN parent_position_id INTEGER");
        logger.info('Coluna parent_position_id adicionada à tabela positions');
      }

      const tradesTableInfo = await this.db.all("PRAGMA table_info(trades)");
      const tradesColumns = tradesTableInfo.map(col => col.name);
      
      if (!tradesColumns.includes('strategy_type')) {
        await this.db.exec("ALTER TABLE trades ADD COLUMN strategy_type TEXT DEFAULT 'original'");
        logger.info('Coluna strategy_type adicionada à tabela trades');
      }

    } catch (error) {
      logger.error('Erro ao adicionar colunas faltantes:', error);
    }
  }

  async createDefaultAdmin() {
    try {
      // Verificar se admin já existe
      const existingAdmin = await this.db.get('SELECT * FROM users WHERE username = ?', ['jean']);
      
      if (!existingAdmin) {
        const bcrypt = await import('bcryptjs');
        const hashedPassword = await bcrypt.default.hash('267589', 12);
        
        await this.db.run(`
          INSERT INTO users (username, email, password, role, approved)
          VALUES (?, ?, ?, ?, ?)
        `, ['jean', 'admin@tradingbot.com', hashedPassword, 'admin', 1]);
        
        logger.info('Usuário administrador padrão criado: jean');
      }

      // Inserir configurações iniciais se não existirem
      const existingConfig = await this.db.get('SELECT * FROM bot_config WHERE id = 1');
      if (!existingConfig) {
        await this.db.run(`
          INSERT INTO bot_config (id, symbol, trade_amount_usdt, trade_amount_percent, test_mode) 
          VALUES (1, 'BTCUSDT', 100, 10.0, 0)
        `);
      }

      const existingState = await this.db.get('SELECT * FROM bot_state WHERE id = 1');
      if (!existingState) {
        await this.db.run(`
          INSERT INTO bot_state (id, total_profit, daily_trades, is_running, last_reset_date)
          VALUES (1, 0, 0, 0, ?)
        `, [new Date().toDateString()]);
      }

      const existingProdBalance = await this.db.get('SELECT * FROM account_balances WHERE test_mode = 0');
      if (!existingProdBalance) {
        await this.db.run(`
          INSERT INTO account_balances (test_mode, usdt_balance, btc_balance)
          VALUES (0, 0.0, 0.0)
        `);
      }

    } catch (error) {
      logger.error('Erro ao criar admin padrão:', error);
    }
  }

  // ===== MÉTODOS ESPECÍFICOS PARA USUÁRIOS =====
  
  // Criar configuração padrão para novo usuário
  async createDefaultUserConfig(userId) {
    try {
      const existingConfig = await this.db.get('SELECT * FROM user_bot_configs WHERE user_id = ?', [userId]);
      
      if (!existingConfig) {
        await this.db.run(`
          INSERT INTO user_bot_configs (
            user_id, symbol, trade_amount_usdt, trade_amount_percent, 
            min_trade_amount_usdt, max_trade_amount_usdt, daily_profit_target,
            stop_loss_percent, max_daily_trades, min_price_change,
            trading_mode, dynamic_coins, original_strategy_percent,
            reinforcement_strategy_percent, reinforcement_trigger_percent,
            enable_reinforcement, base_url, buy_threshold_from_low,
            min_history_for_analysis, recent_trend_window, buy_cooldown_seconds,
            price_poll_interval, log_frequency, maker_fee, taker_fee
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          userId, 'BTCUSDT', 100, 10.0, 5.0, 10000.0, 1.0, 2.0, 10, 0.5,
          'single', '["BTCUSDT","ETHUSDT","BNBUSDT","ADAUSDT","SOLUSDT","XRPUSDT","DOTUSDT","DOGEUSDT","AVAXUSDT","MATICUSDT"]',
          70, 30, 1.0, 1, 'https://api.binance.com', 0.2, 20, 10, 300, 10, 60, 0.001, 0.001
        ]);
        
        logger.info(`Configuração padrão criada para usuário ${userId}`);
      }
      
      // Criar estado padrão
      const existingState = await this.db.get('SELECT * FROM user_bot_states WHERE user_id = ?', [userId]);
      if (!existingState) {
        await this.db.run(`
          INSERT INTO user_bot_states (user_id, total_profit, daily_trades, is_running, last_reset_date)
          VALUES (?, 0, 0, 0, ?)
        `, [userId, new Date().toDateString()]);
        
        logger.info(`Estado padrão criado para usuário ${userId}`);
      }
      
      // Criar saldo padrão
      const existingBalance = await this.db.get('SELECT * FROM user_account_balances WHERE user_id = ?', [userId]);
      if (!existingBalance) {
        await this.db.run(`
          INSERT INTO user_account_balances (user_id, usdt_balance, btc_balance)
          VALUES (?, 0.0, 0.0)
        `, [userId]);
        
        logger.info(`Saldo padrão criado para usuário ${userId}`);
      }
      
    } catch (error) {
      logger.error(`Erro ao criar configuração padrão para usuário ${userId}:`, error);
      throw error;
    }
  }

  async setUserBotRunningState(userId, isRunning) {
    try {
      await this.db.run(
        'UPDATE user_bot_states SET is_running = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
        [isRunning ? 1 : 0, userId]
      );
      
      logger.info(`Estado do bot do usuário ${userId} atualizado: ${isRunning ? 'rodando' : 'parado'}`);
    } catch (error) {
      logger.error(`Erro ao atualizar estado do bot do usuário ${userId}:`, error);
      throw error;
    }
  }

  // NOVO: Obter usuários que tinham bots rodando
  async getRunningUserBots() {
    try {
      const query = `
        SELECT 
          ubs.user_id,
          u.username,
          u.email,
          ubs.is_running,
          ubs.updated_at
        FROM user_bot_states ubs
        JOIN users u ON ubs.user_id = u.id
        WHERE ubs.is_running = 1 AND u.approved = 1
        ORDER BY ubs.updated_at DESC
      `;
      
      const users = await this.db.all(query);
      
      logger.info(`Encontrados ${users.length} usuários com bots que estavam rodando`);
      return users || [];
    } catch (error) {
      logger.error('Erro ao obter usuários com bots rodando:', error);
      return [];
    }
  }

  // Obter configuração do bot do usuário
  async getUserBotConfig(userId) {
    try {
      const config = await this.db.get('SELECT * FROM user_bot_configs WHERE user_id = ?', [userId]);
      
      if (!config) {
        // Criar configuração padrão se não existir
        await this.createDefaultUserConfig(userId);
        return await this.getUserBotConfig(userId);
      }

      // Parse dynamic_coins JSON
      let dynamicCoins;
      try {
        dynamicCoins = config.dynamic_coins ? JSON.parse(config.dynamic_coins) : [
          'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT',
          'XRPUSDT', 'DOTUSDT', 'DOGEUSDT', 'AVAXUSDT', 'MATICUSDT'
        ];
      } catch (e) {
        logger.error('Erro ao fazer parse de dynamic_coins:', e);
        dynamicCoins = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT'];
      }

      return {
        symbol: config.symbol,
        tradeAmountUsdt: config.trade_amount_usdt,
        tradeAmountPercent: config.trade_amount_percent || 10.0,
        minTradeAmountUsdt: config.min_trade_amount_usdt || 5.0,
        maxTradeAmountUsdt: config.max_trade_amount_usdt || 10000.0,
        dailyProfitTarget: config.daily_profit_target,
        stopLossPercent: config.stop_loss_percent,
        maxDailyTrades: config.max_daily_trades,
        minPriceChange: config.min_price_change,
        testMode: false,
        apiKey: config.api_key,
        apiSecret: config.api_secret,
        baseUrl: config.base_url,
        buyThresholdFromLow: config.buy_threshold_from_low,
        minHistoryForAnalysis: config.min_history_for_analysis,
        recentTrendWindow: config.recent_trend_window,
        buyCooldownSeconds: config.buy_cooldown_seconds,
        pricePollInterval: config.price_poll_interval,
        logFrequency: config.log_frequency,
        makerFee: config.maker_fee,
        takerFee: config.taker_fee,
        tradingMode: config.trading_mode || 'single',
        dynamicCoins: dynamicCoins,
        originalStrategyPercent: config.original_strategy_percent || 70,
        reinforcementStrategyPercent: config.reinforcement_strategy_percent || 30,
        reinforcementTriggerPercent: config.reinforcement_trigger_percent || 1.0,
        enableReinforcement: Boolean(config.enable_reinforcement),
        createdAt: config.created_at,
        updatedAt: config.updated_at
      };
    } catch (error) {
      logger.error(`Erro ao obter configurações do usuário ${userId}:`, error);
      return null;
    }
  }

  // Salvar configuração do bot do usuário
  async saveUserBotConfig(userId, config) {
    try {
      // Converter arrays para JSON strings
      const dynamicCoinsJson = Array.isArray(config.dynamicCoins) ? 
        JSON.stringify(config.dynamicCoins) : config.dynamicCoins;

      await this.db.run(`
        UPDATE user_bot_configs 
        SET 
          symbol = ?,
          trade_amount_usdt = ?,
          trade_amount_percent = ?,
          min_trade_amount_usdt = ?,
          max_trade_amount_usdt = ?,
          daily_profit_target = ?,
          stop_loss_percent = ?,
          max_daily_trades = ?,
          min_price_change = ?,
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
          trading_mode = ?,
          dynamic_coins = ?,
          original_strategy_percent = ?,
          reinforcement_strategy_percent = ?,
          reinforcement_trigger_percent = ?,
          enable_reinforcement = ?,
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
        config.apiKey || null,
        config.apiSecret || null,
        config.baseUrl || 'https://api.binance.com',
        config.buyThresholdFromLow || 0.2,
        config.minHistoryForAnalysis || 20,
        config.recentTrendWindow || 10,
        config.buyCooldownSeconds || 300,
        config.pricePollInterval || 10,
        config.logFrequency || 60,
        config.makerFee || 0.001,
        config.takerFee || 0.001,
        config.tradingMode || 'single',
        dynamicCoinsJson,
        config.originalStrategyPercent || 70,
        config.reinforcementStrategyPercent || 30,
        config.reinforcementTriggerPercent || 1.0,
        config.enableReinforcement !== undefined ? (config.enableReinforcement ? 1 : 0) : 1,
        userId
      ]);
      
      logger.info(`Configurações do bot salvas para usuário ${userId}`);
    } catch (error) {
      logger.error(`Erro ao salvar configurações do usuário ${userId}:`, error);
      throw error;
    }
  }

  // Estado do bot do usuário
  async getUserBotState(userId) {
    try {
      return await this.db.get('SELECT * FROM user_bot_states WHERE user_id = ?', [userId]);
    } catch (error) {
      logger.error(`Erro ao obter estado do bot do usuário ${userId}:`, error);
      return null;
    }
  }

  async saveUserBotState(userId, totalProfit, dailyTrades, isRunning = null) {
    try {
      if (isRunning !== null) {
        await this.db.run(`
          UPDATE user_bot_states 
          SET total_profit = ?, daily_trades = ?, is_running = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `, [totalProfit, dailyTrades, isRunning ? 1 : 0, userId]);
      } else {
        await this.db.run(`
          UPDATE user_bot_states 
          SET total_profit = ?, daily_trades = ?, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = ?
        `, [totalProfit, dailyTrades, userId]);
      }
    } catch (error) {
      logger.error(`Erro ao salvar estado do bot do usuário ${userId}:`, error);
    }
  }

  async getUserBotRunningState(userId) {
    try {
      const state = await this.db.get('SELECT is_running FROM user_bot_states WHERE user_id = ?', [userId]);
      return state ? Boolean(state.is_running) : false;
    } catch (error) {
      logger.error(`Erro ao obter estado de execução do bot do usuário ${userId}:`, error);
      return false;
    }
  }

  async resetUserDailyStats(userId) {
    try {
      const today = new Date().toDateString();
      await this.db.run(`
        UPDATE user_bot_states 
        SET daily_trades = 0, last_reset_date = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `, [today, userId]);
    } catch (error) {
      logger.error(`Erro ao resetar estatísticas diárias do usuário ${userId}:`, error);
    }
  }

  // Saldos do usuário
  async updateUserBalance(userId, usdtBalance, btcBalance) {
    try {
      await this.db.run(`
        UPDATE user_account_balances 
        SET usdt_balance = ?, btc_balance = ?, last_updated = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `, [usdtBalance, btcBalance, userId]);
      
      logger.debug(`Saldo atualizado para usuário ${userId} - USDT: ${usdtBalance}, BTC: ${btcBalance}`);
    } catch (error) {
      logger.error(`Erro ao atualizar saldo do usuário ${userId}:`, error);
      throw error;
    }
  }

  async getUserBalance(userId) {
    try {
      const balance = await this.db.get(`
        SELECT usdt_balance, btc_balance, last_updated 
        FROM user_account_balances 
        WHERE user_id = ?
      `, [userId]);
      
      if (!balance) {
        // Criar saldo padrão se não existir
        await this.createDefaultUserConfig(userId);
        return {
          usdtBalance: 0.0,
          btcBalance: 0.0,
          lastUpdated: new Date().toISOString()
        };
      }
      
      return {
        usdtBalance: balance.usdt_balance,
        btcBalance: balance.btc_balance,
        lastUpdated: balance.last_updated
      };
    } catch (error) {
      logger.error(`Erro ao obter saldo do usuário ${userId}:`, error);
      return {
        usdtBalance: 0.0,
        btcBalance: 0.0,
        lastUpdated: new Date().toISOString()
      };
    }
  }

  // Posições do usuário
  async saveUserPosition(userId, position) {
    try {
      await this.db.run(`
        INSERT INTO user_positions (user_id, order_id, symbol, side, quantity, price, status, strategy_type, parent_position_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        position.orderId,
        position.symbol || 'BTCUSDT',
        'BUY',
        position.quantity,
        position.buyPrice,
        'OPEN',
        position.strategyType || 'original',
        position.parentPositionId || null
      ]);
    } catch (error) {
      logger.error(`Erro ao salvar posição do usuário ${userId}:`, error);
    }
  }

  async closeUserPosition(userId, orderId, sellPrice, profit) {
    try {
      await this.db.run(`
        UPDATE user_positions 
        SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, profit = ?
        WHERE user_id = ? AND order_id = ?
      `, [profit, userId, orderId]);

      const position = await this.db.get('SELECT * FROM user_positions WHERE user_id = ? AND order_id = ?', [userId, orderId]);
      if (position) {
        await this.saveUserTrade(userId, {
          orderId: orderId + '_SELL',
          symbol: position.symbol,
          side: 'SELL',
          quantity: position.quantity,
          price: sellPrice,
          profit: profit,
          strategyType: position.strategy_type
        });
      }
    } catch (error) {
      logger.error(`Erro ao fechar posição do usuário ${userId}:`, error);
    }
  }

  async getUserOpenPositions(userId) {
    try {
      const positions = await this.db.all(`
        SELECT * FROM user_positions 
        WHERE user_id = ? AND status = 'OPEN' 
        ORDER BY created_at DESC
      `, [userId]);

      return positions.map(pos => ({
        id: pos.id,
        orderId: pos.order_id,
        symbol: pos.symbol,
        buyPrice: pos.price,
        quantity: pos.quantity,
        timestamp: pos.created_at,
        strategyType: pos.strategy_type,
        parentPositionId: pos.parent_position_id
      }));
    } catch (error) {
      logger.error(`Erro ao obter posições abertas do usuário ${userId}:`, error);
      return [];
    }
  }

  // Trades do usuário
  async saveUserTrade(userId, trade) {
    try {
      await this.db.run(`
        INSERT INTO user_trades (user_id, order_id, symbol, side, quantity, price, fee, profit, strategy_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        trade.orderId,
        trade.symbol || 'BTCUSDT',
        trade.side,
        trade.quantity,
        trade.price,
        trade.fee || 0,
        trade.profit || 0,
        trade.strategyType || 'original'
      ]);
    } catch (error) {
      logger.error(`Erro ao salvar trade do usuário ${userId}:`, error);
    }
  }

  async getUserTradeHistory(userId, limit = 100) {
    try {
      return await this.db.all(`
        SELECT * FROM user_trades 
        WHERE user_id = ?
        ORDER BY executed_at DESC 
        LIMIT ?
      `, [userId, limit]);
    } catch (error) {
      logger.error(`Erro ao obter histórico de trades do usuário ${userId}:`, error);
      return [];
    }
  }

  // Estatísticas do usuário
  async getUserDailyStats(userId, days = 30) {
    try {
      // Por enquanto, retornar estatísticas básicas baseadas nos trades
      const trades = await this.db.all(`
        SELECT DATE(executed_at) as date, COUNT(*) as trades_count, SUM(profit) as total_profit
        FROM user_trades 
        WHERE user_id = ? AND executed_at > datetime('now', '-${days} days')
        GROUP BY DATE(executed_at)
        ORDER BY date DESC
      `, [userId]);
      
      return trades;
    } catch (error) {
      logger.error(`Erro ao obter estatísticas diárias do usuário ${userId}:`, error);
      return [];
    }
  }

  // ===== MÉTODOS DE USUÁRIOS =====
  
  async createUser(userData) {
    const { username, email, password, role = 'user', approved = false } = userData;
    
    const result = await this.db.run(`
      INSERT INTO users (username, email, password, role, approved)
      VALUES (?, ?, ?, ?, ?)
    `, [username, email, password, role, approved ? 1 : 0]);
    
    // Criar configuração padrão para o novo usuário
    await this.createDefaultUserConfig(result.lastID);
    
    return result.lastID;
  }

  async getUserById(id) {
    return await this.db.get('SELECT * FROM users WHERE id = ?', [id]);
  }

  async getUserByUsername(username) {
    return await this.db.get('SELECT * FROM users WHERE username = ?', [username]);
  }

  async getUserByUsernameOrEmail(username, email) {
    return await this.db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, email]);
  }

  async getAllUsers() {
    return await this.db.all('SELECT id, username, email, role, approved, created_at, last_access, access_count FROM users ORDER BY created_at DESC');
  }

  async getPendingUsers() {
    return await this.db.all('SELECT id, username, email, created_at FROM users WHERE approved = 0 ORDER BY created_at ASC');
  }

  async approveUser(userId) {
    await this.db.run('UPDATE users SET approved = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [userId]);
  }

  async updateUser(userId, updates) {
    const fields = [];
    const values = [];
    
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    
    values.push(userId);
    
    await this.db.run(`
      UPDATE users SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP 
      WHERE id = ?
    `, values);
  }

  async deleteUser(userId) {
    await this.db.run('DELETE FROM users WHERE id = ?', [userId]);
  }

  async updateUserLastAccess(userId) {
    await this.db.run(`
      UPDATE users 
      SET last_access = CURRENT_TIMESTAMP, access_count = access_count + 1 
      WHERE id = ?
    `, [userId]);
  }

  // ===== MÉTODOS DE SESSÕES =====
  
  async createSession(userId, token) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 horas
    
    await this.db.run(`
      INSERT INTO sessions (user_id, token, expires_at)
      VALUES (?, ?, ?)
    `, [userId, token, expiresAt.toISOString()]);
  }

  async getSession(token) {
    return await this.db.get('SELECT * FROM sessions WHERE token = ? AND expires_at > CURRENT_TIMESTAMP', [token]);
  }

  async deleteSession(token) {
    await this.db.run('DELETE FROM sessions WHERE token = ?', [token]);
  }

  // NOVO: Deletar todas as sessões de um usuário específico
  async deleteUserSessions(userId) {
    const result = await this.db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    logger.info(`${result.changes} sessões antigas removidas para usuário ID ${userId}`);
    return result.changes;
  }

  async deleteExpiredSessions(timeout) {
    const result = await this.db.run('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP');
    return result.changes;
  }

  async getActiveUsers() {
    // CORRIGIDO: Usar DISTINCT para evitar usuários duplicados e pegar apenas a sessão mais recente
    return await this.db.all(`
      SELECT u.id, u.username, u.email, 
             MAX(s.created_at) as session_start
      FROM users u
      JOIN sessions s ON u.id = s.user_id
      WHERE s.expires_at > CURRENT_TIMESTAMP
      GROUP BY u.id, u.username, u.email
      ORDER BY session_start DESC
    `);
  }

  // ===== NOVOS MÉTODOS PARA TRADING DINÂMICO =====

  // Salvar histórico de preços para múltiplas moedas
  async saveMultiPricePoint(symbol, priceData) {
    try {
      await this.db.run(`
        INSERT INTO multi_price_history (symbol, price, daily_low, daily_high, volume_24h, price_change_24h)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        symbol,
        priceData.price,
        priceData.dailyLow,
        priceData.dailyHigh,
        priceData.volume24h,
        priceData.priceChange24h
      ]);

      // Manter apenas os últimos 1000 registros por símbolo
      await this.db.run(`
        DELETE FROM multi_price_history 
        WHERE symbol = ? AND id NOT IN (
          SELECT id FROM multi_price_history 
          WHERE symbol = ?
          ORDER BY timestamp DESC 
          LIMIT 1000
        )
      `, [symbol, symbol]);
    } catch (error) {
      logger.error(`Erro ao salvar ponto de preço para ${symbol}:`, error);
    }
  }

  // Obter histórico de preços para uma moeda específica
  async getMultiPriceHistory(symbol, hours = 24) {
    try {
      return await this.db.all(`
        SELECT * FROM multi_price_history 
        WHERE symbol = ? AND timestamp > datetime('now', '-${hours} hours')
        ORDER BY timestamp DESC
      `, [symbol]);
    } catch (error) {
      logger.error(`Erro ao obter histórico de preços para ${symbol}:`, error);
      return [];
    }
  }

  // Salvar posição com suporte a estratégias
  async savePositionWithStrategy(position) {
    try {
      const result = await this.db.run(`
        INSERT INTO positions (order_id, symbol, side, quantity, price, status, strategy_type, parent_position_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        position.orderId,
        position.symbol || 'BTCUSDT',
        'BUY',
        position.quantity,
        position.buyPrice,
        'OPEN',
        position.strategyType || 'original',
        position.parentPositionId || null
      ]);
      
      return result.lastID;
    } catch (error) {
      logger.error('Erro ao salvar posição com estratégia:', error);
    }
  }

  // Obter posições abertas por estratégia
  async getOpenPositionsByStrategy(strategyType = null) {
    try {
      let query = `
        SELECT * FROM positions 
        WHERE status = 'OPEN'
      `;
      let params = [];
      
      if (strategyType) {
        query += ` AND strategy_type = ?`;
        params.push(strategyType);
      }
      
      query += ` ORDER BY created_at DESC`;
      
      const positions = await this.db.all(query, params);

      return positions.map(pos => ({
        id: pos.id,
        orderId: pos.order_id,
        symbol: pos.symbol,
        buyPrice: pos.price,
        quantity: pos.quantity,
        timestamp: pos.created_at,
        strategyType: pos.strategy_type,
        parentPositionId: pos.parent_position_id
      }));
    } catch (error) {
      logger.error('Erro ao obter posições abertas por estratégia:', error);
      return [];
    }
  }

  // Salvar trade com informações de estratégia
  async saveTradeWithStrategy(trade) {
    try {
      await this.db.run(`
        INSERT INTO trades (order_id, symbol, side, quantity, price, fee, profit, strategy_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        trade.orderId,
        trade.symbol || 'BTCUSDT',
        trade.side,
        trade.quantity,
        trade.price,
        trade.fee || 0,
        trade.profit || 0,
        trade.strategyType || 'original'
      ]);
    } catch (error) {
      logger.error('Erro ao salvar trade com estratégia:', error);
    }
  }

  // ===== MÉTODOS LEGADOS (COMPATIBILIDADE) =====

  async updateBalance(testMode, usdtBalance, btcBalance) {
    try {
      await this.db.run(`
        UPDATE account_balances 
        SET usdt_balance = ?, btc_balance = ?, last_updated = CURRENT_TIMESTAMP
        WHERE test_mode = 0
      `, [usdtBalance, btcBalance]);
      
      logger.debug(`Saldo atualizado no banco - USDT: ${usdtBalance}, BTC: ${btcBalance}`);
    } catch (error) {
      logger.error('Erro ao atualizar saldo no banco:', error);
      throw error;
    }
  }

  async getBalance(testMode) {
    try {
      const balance = await this.db.get(`
        SELECT usdt_balance, btc_balance, last_updated 
        FROM account_balances 
        WHERE test_mode = 0
      `);
      
      if (!balance) {
        return {
          usdtBalance: 0.0,
          btcBalance: 0.0,
          lastUpdated: new Date().toISOString()
        };
      }
      
      return {
        usdtBalance: balance.usdt_balance,
        btcBalance: balance.btc_balance,
        lastUpdated: balance.last_updated
      };
    } catch (error) {
      logger.error('Erro ao obter saldo do banco:', error);
      return {
        usdtBalance: 0.0,
        btcBalance: 0.0,
        lastUpdated: new Date().toISOString()
      };
    }
  }

  async saveBotState(totalProfit, dailyTrades, isRunning = null) {
    try {
      if (isRunning !== null) {
        await this.db.run(`
          UPDATE bot_state 
          SET total_profit = ?, daily_trades = ?, is_running = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `, [totalProfit, dailyTrades, isRunning ? 1 : 0]);
      } else {
        await this.db.run(`
          UPDATE bot_state 
          SET total_profit = ?, daily_trades = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 1
        `, [totalProfit, dailyTrades]);
      }
    } catch (error) {
      logger.error('Erro ao salvar estado do bot:', error);
    }
  }

  async getBotState() {
    try {
      return await this.db.get('SELECT * FROM bot_state WHERE id = 1');
    } catch (error) {
      logger.error('Erro ao obter estado do bot:', error);
      return null;
    }
  }

  async setBotRunningState(isRunning) {
    try {
      await this.db.run(`
        UPDATE bot_state 
        SET is_running = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `, [isRunning ? 1 : 0]);
    } catch (error) {
      logger.error('Erro ao salvar estado de execução do bot:', error);
    }
  }

  async getBotRunningState() {
    try {
      const state = await this.db.get('SELECT is_running FROM bot_state WHERE id = 1');
      return state ? Boolean(state.is_running) : false;
    } catch (error) {
      logger.error('Erro ao obter estado de execução do bot:', error);
      return false;
    }
  }

  async resetDailyStats() {
    try {
      const today = new Date().toDateString();
      await this.db.run(`
        UPDATE bot_state 
        SET daily_trades = 0, last_reset_date = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `, [today]);
    } catch (error) {
      logger.error('Erro ao resetar estatísticas diárias:', error);
    }
  }

  // Salvar configurações do bot
  async saveBotConfig(config) {
    try {
      // Converter arrays para JSON strings
      const dynamicCoinsJson = Array.isArray(config.dynamicCoins) ? 
        JSON.stringify(config.dynamicCoins) : config.dynamicCoins;

      // CORRIGIDO: Garantir que todas as configurações sejam salvas corretamente
      await this.db.run(`
        UPDATE bot_config 
        SET 
          symbol = ?,
          trade_amount_usdt = ?,
          trade_amount_percent = ?,
          min_trade_amount_usdt = ?,
          max_trade_amount_usdt = ?,
          daily_profit_target = ?,
          stop_loss_percent = ?,
          max_daily_trades = ?,
          min_price_change = ?,
          test_mode = 0,
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
          trading_mode = ?,
          dynamic_coins = ?,
          original_strategy_percent = ?,
          reinforcement_strategy_percent = ?,
          reinforcement_trigger_percent = ?,
          enable_reinforcement = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
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
        config.apiKey || null,
        config.apiSecret || null,
        config.baseUrl || 'https://api.binance.com',
        config.buyThresholdFromLow || 0.2,
        config.minHistoryForAnalysis || 20,
        config.recentTrendWindow || 10,
        config.buyCooldownSeconds || 300,
        config.pricePollInterval || 10,
        config.logFrequency || 60,
        config.makerFee || 0.001,
        config.takerFee || 0.001,
        config.tradingMode || 'single',
        dynamicCoinsJson,
        config.originalStrategyPercent || 70,
        config.reinforcementStrategyPercent || 30,
        config.reinforcementTriggerPercent || 1.0,
        config.enableReinforcement !== undefined ? (config.enableReinforcement ? 1 : 0) : 1
      ]);
      
      logger.info('Configurações do bot salvas no banco de dados');
      logger.debug('Configurações salvas:', {
        tradingMode: config.tradingMode,
        tradeAmountPercent: config.tradeAmountPercent,
        dynamicCoins: dynamicCoinsJson,
        originalStrategyPercent: config.originalStrategyPercent,
        reinforcementStrategyPercent: config.reinforcementStrategyPercent
      });
    } catch (error) {
      logger.error('Erro ao salvar configurações do bot:', error);
      throw error;
    }
  }

  async getBotConfig() {
    try {
      const config = await this.db.get('SELECT * FROM bot_config WHERE id = 1');
      
      if (!config) {
        logger.warn('Nenhuma configuração encontrada no banco, retornando padrões');
        return null;
      }

      // Parse dynamic_coins JSON
      let dynamicCoins;
      try {
        dynamicCoins = config.dynamic_coins ? JSON.parse(config.dynamic_coins) : [
          'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT',
          'XRPUSDT', 'DOTUSDT', 'DOGEUSDT', 'AVAXUSDT', 'MATICUSDT'
        ];
      } catch (e) {
        logger.error('Erro ao fazer parse de dynamic_coins:', e);
        dynamicCoins = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'SOLUSDT'];
      }

      const result = {
        symbol: config.symbol,
        tradeAmountUsdt: config.trade_amount_usdt,
        tradeAmountPercent: config.trade_amount_percent || 10.0,
        minTradeAmountUsdt: config.min_trade_amount_usdt || 5.0,
        maxTradeAmountUsdt: config.max_trade_amount_usdt || 10000.0,
        dailyProfitTarget: config.daily_profit_target,
        stopLossPercent: config.stop_loss_percent,
        maxDailyTrades: config.max_daily_trades,
        minPriceChange: config.min_price_change,
        testMode: false,
        apiKey: config.api_key,
        apiSecret: config.api_secret,
        baseUrl: config.base_url,
        buyThresholdFromLow: config.buy_threshold_from_low,
        minHistoryForAnalysis: config.min_history_for_analysis,
        recentTrendWindow: config.recent_trend_window,
        buyCooldownSeconds: config.buy_cooldown_seconds,
        pricePollInterval: config.price_poll_interval,
        logFrequency: config.log_frequency,
        makerFee: config.maker_fee,
        takerFee: config.taker_fee,
        checkInterval: config.check_interval,
        profitPercentage: config.profit_percentage,
        trailingStop: Boolean(config.trailing_stop),
        trailingStopPercent: config.trailing_stop_percent,
        maxPositions: config.max_positions,
        tradingMode: config.trading_mode || 'single',
        dynamicCoins: dynamicCoins,
        originalStrategyPercent: config.original_strategy_percent || 70,
        reinforcementStrategyPercent: config.reinforcement_strategy_percent || 30,
        reinforcementTriggerPercent: config.reinforcement_trigger_percent || 1.0,
        enableReinforcement: Boolean(config.enable_reinforcement),
        createdAt: config.created_at,
        updatedAt: config.updated_at
      };

      logger.debug('Configuração carregada do banco:', {
        tradingMode: result.tradingMode,
        tradeAmountPercent: result.tradeAmountPercent,
        dynamicCoins: result.dynamicCoins,
        originalStrategyPercent: result.originalStrategyPercent,
        reinforcementStrategyPercent: result.reinforcementStrategyPercent
      });

      return result;
    } catch (error) {
      logger.error('Erro ao obter configurações do bot:', error);
      return null;
    }
  }

  async updateBotConfigFields(fields) {
    try {
      const fieldMappings = {
        symbol: 'symbol',
        tradeAmountUsdt: 'trade_amount_usdt',
        tradeAmountPercent: 'trade_amount_percent',
        minTradeAmountUsdt: 'min_trade_amount_usdt',
        maxTradeAmountUsdt: 'max_trade_amount_usdt',
        dailyProfitTarget: 'daily_profit_target',
        stopLossPercent: 'stop_loss_percent',
        maxDailyTrades: 'max_daily_trades',
        minPriceChange: 'min_price_change',
        apiKey: 'api_key',
        apiSecret: 'api_secret',
        baseUrl: 'base_url',
        buyThresholdFromLow: 'buy_threshold_from_low',
        minHistoryForAnalysis: 'min_history_for_analysis',
        recentTrendWindow: 'recent_trend_window',
        buyCooldownSeconds: 'buy_cooldown_seconds',
        pricePollInterval: 'price_poll_interval',
        logFrequency: 'log_frequency',
        makerFee: 'maker_fee',
        takerFee: 'taker_fee',
        checkInterval: 'check_interval',
        profitPercentage: 'profit_percentage',
        trailingStop: 'trailing_stop',
        trailingStopPercent: 'trailing_stop_percent',
        maxPositions: 'max_positions',
        tradingMode: 'trading_mode',
        dynamicCoins: 'dynamic_coins',
        originalStrategyPercent: 'original_strategy_percent',
        reinforcementStrategyPercent: 'reinforcement_strategy_percent',
        reinforcementTriggerPercent: 'reinforcement_trigger_percent',
        enableReinforcement: 'enable_reinforcement'
      };

      const updates = [];
      const values = [];

      for (const [jsField, dbField] of Object.entries(fieldMappings)) {
        if (fields.hasOwnProperty(jsField)) {
          updates.push(`${dbField} = ?`);
          let value = fields[jsField];
          
          if (typeof value === 'boolean') {
            value = value ? 1 : 0;
          } else if (jsField === 'dynamicCoins' && Array.isArray(value)) {
            value = JSON.stringify(value);
          }
          
          values.push(value);
        }
      }

      if (updates.length > 0) {
        updates.push('test_mode = 0');
        updates.push('updated_at = CURRENT_TIMESTAMP');
        
        const query = `UPDATE bot_config SET ${updates.join(', ')} WHERE id = 1`;
        await this.db.run(query, values);
        
        logger.info('Configurações atualizadas no banco:', Object.keys(fields));
        logger.debug('Valores salvos:', fields);
      }
    } catch (error) {
      logger.error('Erro ao atualizar configurações:', error);
      throw error;
    }
  }

  async savePosition(position) {
    try {
      await this.db.run(`
        INSERT INTO positions (order_id, symbol, side, quantity, price, status, strategy_type, parent_position_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        position.orderId,
        position.symbol || 'BTCUSDT',
        'BUY',
        position.quantity,
        position.buyPrice,
        'OPEN',
        position.strategyType || 'original',
        position.parentPositionId || null
      ]);
    } catch (error) {
      logger.error('Erro ao salvar posição:', error);
    }
  }

  async closePosition(orderId, sellPrice, profit) {
    try {
      await this.db.run(`
        UPDATE positions 
        SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, profit = ?
        WHERE order_id = ?
      `, [profit, orderId]);

      const position = await this.db.get('SELECT * FROM positions WHERE order_id = ?', [orderId]);
      if (position) {
        await this.saveTrade({
          orderId: orderId + '_SELL',
          symbol: position.symbol,
          side: 'SELL',
          quantity: position.quantity,
          price: sellPrice,
          profit: profit,
          strategyType: position.strategy_type
        });
      }
    } catch (error) {
      logger.error('Erro ao fechar posição:', error);
    }
  }

  async getOpenPositions() {
    try {
      const positions = await this.db.all(`
        SELECT * FROM positions 
        WHERE status = 'OPEN' 
        ORDER BY created_at DESC
      `);

      return positions.map(pos => ({
        id: pos.id,
        orderId: pos.order_id,
        symbol: pos.symbol,
        buyPrice: pos.price,
        quantity: pos.quantity,
        timestamp: pos.created_at,
        strategyType: pos.strategy_type,
        parentPositionId: pos.parent_position_id
      }));
    } catch (error) {
      logger.error('Erro ao obter posições abertas:', error);
      return [];
    }
  }

  async saveTrade(trade) {
    try {
      await this.db.run(`
        INSERT INTO trades (order_id, symbol, side, quantity, price, fee, profit, strategy_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        trade.orderId,
        trade.symbol || 'BTCUSDT',
        trade.side,
        trade.quantity,
        trade.price,
        trade.fee || 0,
        trade.profit || 0,
        trade.strategyType || 'original'
      ]);
    } catch (error) {
      logger.error('Erro ao salvar trade:', error);
    }
  }

  async getTradeHistory(limit = 100) {
    try {
      return await this.db.all(`
        SELECT * FROM trades 
        ORDER BY executed_at DESC 
        LIMIT ?
      `, [limit]);
    } catch (error) {
      logger.error('Erro ao obter histórico de trades:', error);
      return [];
    }
  }

  async savePricePoint(symbol, price) {
    try {
      await this.db.run(`
        INSERT INTO price_history (symbol, price)
        VALUES (?, ?)
      `, [symbol, price]);

      await this.db.run(`
        DELETE FROM price_history 
        WHERE id NOT IN (
          SELECT id FROM price_history 
          ORDER BY timestamp DESC 
          LIMIT 10000
        )
      `);
    } catch (error) {
      logger.error('Erro ao salvar ponto de preço:', error);
    }
  }

  async getPriceHistory(symbol, hours = 24) {
    try {
      return await this.db.all(`
        SELECT * FROM price_history 
        WHERE symbol = ? AND timestamp > datetime('now', '-${hours} hours')
        ORDER BY timestamp DESC
      `, [symbol]);
    } catch (error) {
      logger.error('Erro ao obter histórico de preços:', error);
      return [];
    }
  }

  async saveDailyStats(date, symbol, tradesCount, totalProfit, dailyLow, dailyHigh) {
    try {
      await this.db.run(`
        INSERT OR REPLACE INTO daily_stats 
        (date, symbol, trades_count, total_profit, daily_low, daily_high)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [date, symbol, tradesCount, totalProfit, dailyLow, dailyHigh]);
    } catch (error) {
      logger.error('Erro ao salvar estatísticas diárias:', error);
    }
  }

  async getDailyStats(days = 30) {
    try {
      return await this.db.all(`
        SELECT * FROM daily_stats 
        ORDER BY date DESC 
        LIMIT ?
      `, [days]);
    } catch (error) {
      logger.error('Erro ao obter estatísticas diárias:', error);
      return [];
    }
  }

  async close() {
    try {
      if (this.db) {
        await this.db.close();
        logger.info('Conexão com banco de dados fechada');
      }
    } catch (error) {
      logger.error('Erro ao fechar banco de dados:', error);
    }
  }
}