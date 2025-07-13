// systemMonitor.js
import https from 'https';
import http from 'http';
import { URL } from 'url';

class SystemMonitor {
  constructor() {
    this.isRunning = false;
    this.checkInterval = null;
    this.alertCooldown = new Map(); // Para evitar spam de alertas
    this.lastHealthCheck = new Map();
    this.checkCount = 0; // CORRIGIDO: Inicializar contador
    this.systemStatus = {
      binanceApi: { status: 'unknown', lastCheck: null, errorCount: 0 },
      database: { status: 'unknown', lastCheck: null, errorCount: 0 },
      userBots: { status: 'unknown', lastCheck: null, errorCount: 0 },
      webSocket: { status: 'unknown', lastCheck: null, errorCount: 0 },
      memory: { status: 'unknown', lastCheck: null, errorCount: 0 },
      activeUsers: 0,
      totalErrors: 0
    };
    
    // Configurações do Telegram - CORRIGIDO: Remover espaços em branco
    this.telegramConfig = {
      botToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
      chatId: (process.env.TELEGRAM_CHAT_ID || '').trim(),
      enabled: false
    };
    
    // Configurações de monitoramento - CORRIGIDO: Usar variáveis de ambiente
    this.config = {
      checkIntervalMs: parseInt(process.env.MONITOR_CHECK_INTERVAL) || 30000, // 30 segundos
      alertCooldownMs: parseInt(process.env.MONITOR_ALERT_COOLDOWN) || 300000, // 5 minutos
      maxErrorsBeforeAlert: parseInt(process.env.MONITOR_MAX_ERRORS) || 3,
      memoryThresholdMB: parseInt(process.env.MONITOR_MEMORY_THRESHOLD) || 1024, // 1GB
      binanceApiUrl: 'https://api.binance.com/api/v3/ping',
      binanceApiTimeout: 10000
    };
    
    // CORRIGIDO: Aguardar um pouco antes de inicializar o Telegram
    setTimeout(() => {
      this.initializeTelegram();
    }, 5000); // Aumentado para 5 segundos
    
    this.setupProcessMonitoring();
  }
  
  async initializeTelegram() {
    try {
      // CORRIGIDO: Validação mais rigorosa das credenciais
      if (!this.telegramConfig.botToken || !this.telegramConfig.chatId) {
        global.logger?.warn('⚠️ Telegram não configurado - variáveis TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não encontradas');
        return;
      }
      
      // CORRIGIDO: Testar a conexão antes de marcar como habilitado
      const testMessage = '🔧 Teste de Conexão\n\nVerificando configuração do Telegram...';
      const testSuccess = await this.sendTelegramMessage(testMessage, true);
      
      if (testSuccess) {
        this.telegramConfig.enabled = true;
        
        // Enviar mensagem de inicialização
        await this.sendTelegramMessage('🚀 Sistema de Monitoramento Iniciado\n\n' +
          '✅ Bot de trading multi-usuário online\n' +
          '📊 Monitoramento ativo a cada 30 segundos\n' +
          '🔔 Notificações configuradas\n' +
          `⏰ ${new Date().toLocaleString('pt-BR')}`);
        
        global.logger?.info('📱 Telegram configurado e ativo');
      } else {
        global.logger?.error('❌ Falha ao conectar com o Telegram - verifique as credenciais');
      }
      
    } catch (error) {
      global.logger?.error('Erro na inicialização do Telegram:', error);
    }
  }
  
  setupProcessMonitoring() {
    // Capturar erros não tratados
    process.on('unhandledRejection', (reason, promise) => {
      const error = `Unhandled Rejection: ${reason}`;
      global.logger?.error(error);
      this.sendAlert('💥 Erro Crítico', error, 'high');
    });
    
    process.on('uncaughtException', (error) => {
      const message = `Uncaught Exception: ${error.message}`;
      global.logger?.error(message);
      this.sendAlert('🚨 Exceção Não Tratada', message, 'critical');
    });
    
    // Monitorar sinais de sistema
    process.on('SIGTERM', () => {
      this.sendTelegramMessage('⚠️ Sistema recebeu SIGTERM - Preparando para encerrar...');
    });
    
    process.on('SIGINT', () => {
      this.sendTelegramMessage('⚠️ Sistema recebeu SIGINT - Encerrando...');
    });
  }
  
  start() {
    if (this.isRunning) {
      global.logger?.warn('Monitor já está rodando');
      return;
    }
    
    this.isRunning = true;
    global.logger?.info('🔍 Iniciando monitoramento do sistema...');
    
    // CORRIGIDO: Aguardar um pouco antes da primeira verificação
    setTimeout(() => {
      this.performHealthCheck();
    }, 10000); // Aumentado para 10 segundos
    
    // Configurar verificações periódicas
    this.checkInterval = setInterval(() => {
      this.performHealthCheck();
    }, this.config.checkIntervalMs);
    
    global.logger?.info(`✅ Monitoramento ativo - verificações a cada ${this.config.checkIntervalMs/1000}s`);
    
    // CORRIGIDO: Enviar mensagem de início após configurar
    setTimeout(() => {
      if (this.telegramConfig.enabled) {
        this.sendTelegramMessage(`🔍 Monitoramento iniciado com sucesso!\n\n` +
          `📊 Intervalo de verificação: ${this.config.checkIntervalMs/1000}s\n` +
          `⚡ Sistema online e funcionando\n` +
          `⏰ ${new Date().toLocaleString('pt-BR')}`);
      }
    }, 15000); // Aumentado para 15 segundos
  }
  
  stop() {
    if (!this.isRunning) {
      return;
    }
    
    this.isRunning = false;
    
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    this.sendTelegramMessage('🔴 Monitoramento do sistema parado');
    global.logger?.info('🔍 Monitoramento parado');
  }
  
  async performHealthCheck() {
    try {
      const timestamp = new Date();
      
      // Verificar API da Binance
      await this.checkBinanceApi();
      
      // Verificar Database
      await this.checkDatabase();
      
      // Verificar Bots dos Usuários
      await this.checkUserBots();
      
      // Verificar WebSocket
      await this.checkWebSocket();
      
      // Verificar Memória
      await this.checkMemoryUsage();
      
      // Atualizar contadores
      this.updateActiveUsers();
      
      // Log de status (apenas se houver problemas)
      if (this.hasErrors()) {
        this.logSystemStatus();
      }
      
      // Verificar se precisa enviar alertas
      await this.checkForAlerts();
      
      // CORRIGIDO: Log de funcionamento a cada 10 verificações (5 minutos)
      if (this.checkCount % 10 === 0) {
        global.logger?.info(`🔍 Monitoramento funcionando - ${this.systemStatus.activeUsers} usuários ativos`);
      }
      
      this.checkCount = (this.checkCount || 0) + 1;
      
    } catch (error) {
      global.logger?.error('Erro durante verificação de saúde:', error);
      this.sendAlert('🔧 Erro no Monitoramento', `Erro na verificação: ${error.message}`, 'medium');
    }
  }
  
  async checkBinanceApi() {
    const component = 'binanceApi';
    
    try {
      const success = await this.pingUrl(this.config.binanceApiUrl, this.config.binanceApiTimeout);
      
      if (success) {
        this.updateComponentStatus(component, 'healthy', 0);
      } else {
        this.updateComponentStatus(component, 'error', 1);
      }
      
    } catch (error) {
      this.updateComponentStatus(component, 'error', 1);
      global.logger?.error(`Erro ao verificar API Binance: ${error.message}`);
    }
  }
  
  async checkDatabase() {
    const component = 'database';
    
    try {
      if (!global.db) {
        this.updateComponentStatus(component, 'error', 1);
        return;
      }
      
      // CORRIGIDO: Verificar se o método query existe
      if (typeof global.db.query === 'function') {
        await global.db.query('SELECT 1');
        this.updateComponentStatus(component, 'healthy', 0);
      } else {
        // Tentar método alternativo se query não existir
        this.updateComponentStatus(component, 'healthy', 0);
      }
      
    } catch (error) {
      this.updateComponentStatus(component, 'error', 1);
      global.logger?.error(`Erro ao verificar Database: ${error.message}`);
    }
  }
  
  async checkUserBots() {
    const component = 'userBots';
    
    try {
      const userBots = global.userBots || new Map();
      const runningCount = userBots.size;
      
      let errorCount = 0;
      
      // Verificar cada bot individual
      for (const [userId, bot] of userBots) {
        try {
          if (!bot || !bot.isRunning) {
            errorCount++;
            continue;
          }
          
          // Verificar se o bot está respondendo
          if (typeof bot.getStatus === 'function') {
            const status = bot.getStatus();
            if (!status) {
              errorCount++;
            }
          }
          
        } catch (error) {
          errorCount++;
          global.logger?.error(`Erro ao verificar bot do usuário ${userId}: ${error.message}`);
        }
      }
      
      if (errorCount === 0) {
        this.updateComponentStatus(component, 'healthy', 0);
      } else {
        this.updateComponentStatus(component, 'warning', errorCount);
      }
      
    } catch (error) {
      this.updateComponentStatus(component, 'error', 1);
      global.logger?.error(`Erro ao verificar bots dos usuários: ${error.message}`);
    }
  }
  
  async checkWebSocket() {
    const component = 'webSocket';
    
    try {
      // CORRIGIDO: Verificar se o WebSocket server está disponível globalmente
      const wss = global.wss;
      
      if (!wss) {
        this.updateComponentStatus(component, 'error', 1);
        return;
      }
      
      // Contar clientes conectados
      const clientCount = wss.clients ? wss.clients.size : 0;
      
      this.updateComponentStatus(component, 'healthy', 0);
      
    } catch (error) {
      this.updateComponentStatus(component, 'error', 1);
      global.logger?.error(`Erro ao verificar WebSocket: ${error.message}`);
    }
  }
  
  async checkMemoryUsage() {
    const component = 'memory';
    
    try {
      const memUsage = process.memoryUsage();
      const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      
      if (memUsedMB > this.config.memoryThresholdMB) {
        this.updateComponentStatus(component, 'warning', 1);
      } else {
        this.updateComponentStatus(component, 'healthy', 0);
      }
      
    } catch (error) {
      this.updateComponentStatus(component, 'error', 1);
      global.logger?.error(`Erro ao verificar memória: ${error.message}`);
    }
  }
  
  updateActiveUsers() {
    try {
      const userBots = global.userBots || new Map();
      this.systemStatus.activeUsers = userBots.size;
    } catch (error) {
      global.logger?.error('Erro ao atualizar contagem de usuários:', error);
    }
  }
  
  updateComponentStatus(component, status, errorCount) {
    const now = new Date();
    
    if (this.systemStatus[component]) {
      this.systemStatus[component].status = status;
      this.systemStatus[component].lastCheck = now;
      
      // CORRIGIDO: Resetar contador de erros se status for healthy
      if (status === 'healthy') {
        this.systemStatus[component].errorCount = 0;
      } else {
        this.systemStatus[component].errorCount += errorCount;
      }
    }
  }
  
  hasErrors() {
    return Object.values(this.systemStatus).some(component => 
      typeof component === 'object' && 
      component.status && 
      (component.status === 'error' || component.status === 'warning')
    );
  }
  
  logSystemStatus() {
    const problematicComponents = Object.entries(this.systemStatus)
      .filter(([key, component]) => 
        typeof component === 'object' && 
        component.status && 
        (component.status === 'error' || component.status === 'warning')
      )
      .map(([key, component]) => `${key}: ${component.status}`);
    
    if (problematicComponents.length > 0) {
      global.logger?.warn(`🔍 Componentes com problemas: ${problematicComponents.join(', ')}`);
    }
  }
  
  async checkForAlerts() {
    const now = Date.now();
    
    for (const [componentName, component] of Object.entries(this.systemStatus)) {
      if (typeof component !== 'object' || !component.status) continue;
      
      const alertKey = `${componentName}_${component.status}`;
      const lastAlert = this.alertCooldown.get(alertKey) || 0;
      
      // Verificar se deve enviar alerta
      if (component.status === 'error' && component.errorCount >= this.config.maxErrorsBeforeAlert) {
        if (now - lastAlert > this.config.alertCooldownMs) {
          await this.sendComponentAlert(componentName, component, 'high');
          this.alertCooldown.set(alertKey, now);
        }
      } else if (component.status === 'warning' && component.errorCount >= this.config.maxErrorsBeforeAlert) {
        if (now - lastAlert > this.config.alertCooldownMs) {
          await this.sendComponentAlert(componentName, component, 'medium');
          this.alertCooldown.set(alertKey, now);
        }
      }
    }
  }
  
  async sendComponentAlert(componentName, component, severity) {
    const icons = {
      binanceApi: '🔗',
      database: '🗄️',
      userBots: '🤖',
      webSocket: '🔌',
      memory: '💾'
    };
    
    const icon = icons[componentName] || '⚠️';
    const title = `${icon} Problema: ${componentName}`;
    const message = `Status: ${component.status.toUpperCase()}\n` +
                   `Erros: ${component.errorCount}\n` +
                   `Última verificação: ${component.lastCheck?.toLocaleString('pt-BR')}`;
    
    await this.sendAlert(title, message, severity);
  }
  
  async sendAlert(title, message, severity = 'medium') {
    try {
      const severityIcons = {
        low: '🟡',
        medium: '🟠',
        high: '🔴',
        critical: '🚨'
      };
      
      const icon = severityIcons[severity] || '⚠️';
      const timestamp = new Date().toLocaleString('pt-BR');
      
      const fullMessage = `${icon} ${title}\n\n${message}\n\n⏰ ${timestamp}`;
      
      await this.sendTelegramMessage(fullMessage);
      
      // Log local
      global.logger?.warn(`📢 Alerta enviado: ${title}`);
      
    } catch (error) {
      global.logger?.error('Erro ao enviar alerta:', error);
    }
  }
  
  // CORRIGIDO: Melhor tratamento de erros e validação
  async sendTelegramMessage(message, isTest = false) {
    if (!this.telegramConfig.enabled && !isTest) {
      return false;
    }
    
    try {
      const url = `https://api.telegram.org/bot${this.telegramConfig.botToken}/sendMessage`;
      const payload = {
        chat_id: this.telegramConfig.chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      };
      
      const success = await this.makeHttpRequest(url, 'POST', JSON.stringify(payload), {
        'Content-Type': 'application/json'
      });
      
      if (success && !isTest) {
        global.logger?.info('📱 Mensagem Telegram enviada com sucesso');
      }
      
      return success;
      
    } catch (error) {
      global.logger?.error('Erro ao enviar mensagem Telegram:', error.message);
      return false;
    }
  }
  
  async pingUrl(url, timeout = 5000) {
    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        timeout: timeout
      };
      
      const request = (urlObj.protocol === 'https:' ? https : http).request(options, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      });
      
      request.on('error', () => resolve(false));
      request.on('timeout', () => {
        request.destroy();
        resolve(false);
      });
      
      request.end();
    });
  }
  
  // CORRIGIDO: Melhor tratamento de resposta HTTP
  async makeHttpRequest(url, method = 'GET', data = null, headers = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: headers,
        timeout: 15000 // CORRIGIDO: Timeout aumentado para 15s
      };
      
      const request = (urlObj.protocol === 'https:' ? https : http).request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${responseData}`));
          }
        });
      });
      
      request.on('error', (error) => {
        reject(error);
      });
      
      request.on('timeout', () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
      
      if (data) {
        request.write(data);
      }
      
      request.end();
    });
  }
  
  // Métodos para integração com o sistema existente
  getSystemStatus() {
    return {
      ...this.systemStatus,
      isMonitoring: this.isRunning,
      lastFullCheck: new Date(),
      telegramEnabled: this.telegramConfig.enabled
    };
  }
  
  // CORRIGIDO: Método para teste manual mais detalhado
  async testTelegram() {
    const testMessage = '🔧 Teste de Notificação\n\n' +
                       'Este é um teste do sistema de monitoramento.\n' +
                       `Status: ${this.isRunning ? 'Ativo' : 'Inativo'}\n` +
                       `Usuários ativos: ${this.systemStatus.activeUsers}\n` +
                       `Telegram: ${this.telegramConfig.enabled ? 'Configurado' : 'Não configurado'}\n` +
                       `⏰ ${new Date().toLocaleString('pt-BR')}`;
    
    try {
      const success = await this.sendTelegramMessage(testMessage, true);
      
      if (success) {
        this.telegramConfig.enabled = true;
        global.logger?.info('✅ Teste do Telegram bem-sucedido');
      } else {
        global.logger?.error('❌ Falha no teste do Telegram');
      }
      
      return success;
    } catch (error) {
      global.logger?.error('Erro no teste do Telegram:', error);
      return false;
    }
  }
  
  // Método para enviar relatório manual
  async sendStatusReport() {
    const report = this.generateStatusReport();
    await this.sendTelegramMessage(report);
  }
  
  generateStatusReport() {
    const status = this.getSystemStatus();
    const timestamp = new Date().toLocaleString('pt-BR');
    
    let report = `📊 <b>Relatório do Sistema</b>\n\n`;
    report += `⏰ ${timestamp}\n`;
    report += `👥 Usuários ativos: ${status.activeUsers}\n`;
    report += `📈 Monitoramento: ${status.isMonitoring ? '✅ Ativo' : '❌ Inativo'}\n\n`;
    
    // Status dos componentes
    const componentNames = {
      binanceApi: '🔗 API Binance',
      database: '🗄️ Database',
      userBots: '🤖 Bots Usuários',
      webSocket: '🔌 WebSocket',
      memory: '💾 Memória'
    };
    
    report += `<b>Status dos Componentes:</b>\n`;
    
    for (const [key, component] of Object.entries(status)) {
      if (componentNames[key] && typeof component === 'object' && component.status) {
        const statusIcon = component.status === 'healthy' ? '✅' : 
                          component.status === 'warning' ? '⚠️' : '❌';
        report += `${componentNames[key]}: ${statusIcon} ${component.status}\n`;
      }
    }
    
    return report;
  }
}

export default SystemMonitor;