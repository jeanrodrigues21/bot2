import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import logger from './logger.js';

export default class AuthManager {
  constructor(database) {
    this.db = database;
    // Usar um JWT Secret fixo ou do .env para evitar invalidação de tokens
    this.jwtSecret = process.env.JWT_SECRET || 'trading-bot-secret-key-2024-fixed-secret-for-production-use';
    this.saltRounds = 12;
    this.sessionTimeout = 24 * 60 * 60 * 1000; // 24 horas
    
    // Sistema de rate limiting para tentativas de login
    this.loginAttempts = new Map(); // IP -> { attempts, lastAttempt, blockedUntil }
    this.maxLoginAttempts = 5;
    this.lockoutDuration = 15 * 60 * 1000; // 15 minutos
    this.attemptWindow = 5 * 60 * 1000; // 5 minutos
  }

  // Gerar hash da senha
  async hashPassword(password) {
    return await bcrypt.hash(password, this.saltRounds);
  }

  // Verificar senha
  async verifyPassword(password, hash) {
    return await bcrypt.compare(password, hash);
  }

  // Rate limiting para tentativas de login
  checkRateLimit(ip) {
    const now = Date.now();
    const attempts = this.loginAttempts.get(ip);
    
    if (!attempts) {
      return { allowed: true, remainingAttempts: this.maxLoginAttempts };
    }
    
    // Se está bloqueado, verificar se o tempo passou
    if (attempts.blockedUntil && now < attempts.blockedUntil) {
      const remainingTime = Math.ceil((attempts.blockedUntil - now) / 1000 / 60);
      logger.warn(`Tentativa de login bloqueada para IP ${ip}. Tempo restante: ${remainingTime} minutos`);
      return { 
        allowed: false, 
        remainingAttempts: 0,
        blockedUntil: attempts.blockedUntil,
        message: `Muitas tentativas de login. Tente novamente em ${remainingTime} minutos.`
      };
    }
    
    // Se passou do tempo de bloqueio, resetar
    if (attempts.blockedUntil && now >= attempts.blockedUntil) {
      this.loginAttempts.delete(ip);
      return { allowed: true, remainingAttempts: this.maxLoginAttempts };
    }
    
    // Verificar se as tentativas estão dentro da janela de tempo
    if (now - attempts.lastAttempt > this.attemptWindow) {
      // Reset attempts se passou da janela de tempo
      this.loginAttempts.delete(ip);
      return { allowed: true, remainingAttempts: this.maxLoginAttempts };
    }
    
    // Verificar se excedeu o limite
    if (attempts.count >= this.maxLoginAttempts) {
      attempts.blockedUntil = now + this.lockoutDuration;
      const remainingTime = Math.ceil(this.lockoutDuration / 1000 / 60);
      logger.warn(`IP ${ip} bloqueado por ${remainingTime} minutos após ${this.maxLoginAttempts} tentativas falhadas`);
      return { 
        allowed: false, 
        remainingAttempts: 0,
        blockedUntil: attempts.blockedUntil,
        message: `Muitas tentativas de login. Tente novamente em ${remainingTime} minutos.`
      };
    }
    
    return { 
      allowed: true, 
      remainingAttempts: this.maxLoginAttempts - attempts.count 
    };
  }

  // Registrar tentativa de login
  recordLoginAttempt(ip, success) {
    const now = Date.now();
    
    if (success) {
      // Login bem-sucedido, limpar tentativas
      this.loginAttempts.delete(ip);
      logger.info(`Login bem-sucedido para IP ${ip}`);
      return;
    }
    
    // Login falhado, incrementar contador
    const attempts = this.loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count++;
    attempts.lastAttempt = now;
    
    this.loginAttempts.set(ip, attempts);
    
    logger.warn(`Tentativa de login falhada para IP ${ip}. Tentativas: ${attempts.count}/${this.maxLoginAttempts}`);
  }

  // Simular verificação de senha mesmo quando usuário não existe (timing attack protection)
  async simulatePasswordCheck() {
    // Fazer um hash dummy para manter o tempo de resposta consistente
    const dummyPassword = 'dummy_password_for_timing_protection';
    const dummyHash = '$2b$12$dummy.hash.to.prevent.timing.attacks.and.user.enumeration';
    
    try {
      await bcrypt.compare(dummyPassword, dummyHash);
    } catch (error) {
      // Ignorar erro, é apenas para simular tempo de processamento
    }
  }

  // Gerar token JWT
  generateToken(user) {
    return jwt.sign(
      { 
        id: user.id, 
        username: user.username, 
        email: user.email,
        role: user.role,
        approved: user.approved 
      },
      this.jwtSecret,
      { expiresIn: '24h' }
    );
  }

  // Verificar token JWT
  verifyToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch (error) {
      logger.error('Token inválido:', error.message);
      return null;
    }
  }

  // Registrar novo usuário
  async register(username, email, password) {
    try {
      // Verificar se usuário já existe
      const existingUser = await this.db.getUserByUsernameOrEmail(username, email);
      if (existingUser) {
        throw new Error('Usuário ou e-mail já cadastrado');
      }

      // Hash da senha
      const hashedPassword = await this.hashPassword(password);

      // Criar usuário (pendente de aprovação)
      const userId = await this.db.createUser({
        username,
        email,
        password: hashedPassword,
        approved: false,
        role: 'user'
      });

      // Configuração padrão já é criada automaticamente no createUser
      
      logger.info(`Novo usuário registrado: ${username} (${email}) - Aguardando aprovação`);
      
      return {
        success: true,
        message: 'Usuário registrado com sucesso. Aguarde aprovação do administrador.',
        userId
      };
    } catch (error) {
      logger.error('Erro no registro:', error.message);
      throw error;
    }
  }

  // Login do usuário com proteções de segurança
  async login(username, password, clientIp = 'unknown') {
    try {
      // 1. Verificar rate limiting
      const rateLimit = this.checkRateLimit(clientIp);
      if (!rateLimit.allowed) {
        throw new Error(rateLimit.message);
      }

      // 2. Buscar usuário
      const user = await this.db.getUserByUsername(username);
      
      // 3. SEMPRE verificar senha (mesmo se usuário não existir) para prevenir timing attacks
      let isValidPassword = false;
      
      if (user) {
        isValidPassword = await this.verifyPassword(password, user.password);
      } else {
        // Simular verificação de senha para manter tempo de resposta consistente
        await this.simulatePasswordCheck();
      }

      // 4. Verificar credenciais e status do usuário
      if (!user || !isValidPassword) {
        // Registrar tentativa falhada
        this.recordLoginAttempt(clientIp, false);
        
        // Log de segurança (sem revelar se é usuário ou senha)
        logger.warn(`Tentativa de login com credenciais inválidas para usuário: ${username} | IP: ${clientIp}`);
        
        // Mensagem genérica para não revelar se usuário existe
        throw new Error('Credenciais inválidas. Verifique seu usuário e senha.');
      }

      // 5. Verificar se usuário está aprovado
      if (!user.approved) {
        // Registrar tentativa falhada (usuário existe mas não aprovado)
        this.recordLoginAttempt(clientIp, false);
        
        logger.warn(`Tentativa de login de usuário não aprovado: ${username} | IP: ${clientIp}`);
        throw new Error('Sua conta ainda não foi aprovada pelo administrador.');
      }

      // 6. Login bem-sucedido
      this.recordLoginAttempt(clientIp, true);

      // Limpar sessões antigas do usuário antes de criar nova
      await this.db.deleteUserSessions(user.id);

      // Atualizar último acesso
      await this.db.updateUserLastAccess(user.id);

      // Gerar token
      const token = this.generateToken(user);

      // Criar nova sessão
      await this.db.createSession(user.id, token);

      logger.info(`Login realizado com sucesso: ${user.username} | IP: ${clientIp}`);

      return {
        success: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role
        }
      };
    } catch (error) {
      logger.error(`Erro no login para usuário ${username} | IP: ${clientIp} | Erro: ${error.message}`);
      throw error;
    }
  }

  // Logout
  async logout(token) {
    try {
      await this.db.deleteSession(token);
      logger.info('Logout realizado');
      return { success: true };
    } catch (error) {
      logger.error('Erro no logout:', error.message);
      throw error;
    }
  }

  // CORRIGIDO: Middleware de autenticação
  async authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    logger.info(`🔐 Verificando token para ${req.method} ${req.path}`);
    logger.info(`📋 Auth header: ${authHeader ? 'Bearer [TOKEN]' : 'Não fornecido'}`);

    if (!token) {
      logger.error('❌ Token de acesso não fornecido');
      return res.status(401).json({ error: 'Token de acesso requerido' });
    }

    try {
      // Verificar token JWT primeiro
      const decoded = this.verifyToken(token);
      if (!decoded) {
        logger.error('❌ Token JWT inválido ou expirado');
        return res.status(403).json({ error: 'Token inválido' });
      }

      logger.info(`🔍 Token decodificado para usuário: ${decoded.username} (ID: ${decoded.id})`);

      // Verificar se sessão existe no banco
      const session = await this.db.getSession(token);
      if (!session) {
        logger.error('❌ Sessão não encontrada no banco de dados');
        return res.status(401).json({ error: 'Sessão inválida' });
      }

      logger.info(`✅ Sessão válida encontrada para usuário ID: ${session.user_id}`);

      // Verificar se usuário ainda está aprovado
      const user = await this.db.getUserById(decoded.id);
      if (!user || !user.approved) {
        logger.error(`❌ Usuário não autorizado: ${decoded.username}`);
        return res.status(403).json({ error: 'Usuário não autorizado' });
      }

      logger.info(`✅ Usuário autorizado: ${user.username}`);

      req.user = decoded;
      next();
    } catch (error) {
      logger.error('❌ Erro na autenticação:', error.message);
      return res.status(403).json({ error: 'Token inválido' });
    }
  }

  // Middleware para admin
  async requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
      logger.error(`Acesso negado para usuário não-admin: ${req.user.username}`);
      return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
    }
    next();
  }

  // Aprovar usuário
  async approveUser(userId) {
    try {
      await this.db.approveUser(userId);
      const user = await this.db.getUserById(userId);
      
      logger.info(`Usuário aprovado: ${user.username}`);
      
      // Aqui seria o envio de e-mail (implementação futura)
      // await this.sendApprovalEmail(user.email);
      
      return { success: true, message: 'Usuário aprovado com sucesso' };
    } catch (error) {
      logger.error('Erro ao aprovar usuário:', error.message);
      throw error;
    }
  }

  // Rejeitar usuário
  async rejectUser(userId) {
    try {
      await this.db.deleteUser(userId);
      logger.info(`Usuário rejeitado e removido: ID ${userId}`);
      return { success: true, message: 'Usuário rejeitado e removido' };
    } catch (error) {
      logger.error('Erro ao rejeitar usuário:', error.message);
      throw error;
    }
  }

  // Limpar sessões expiradas
  async cleanExpiredSessions() {
    try {
      const expiredCount = await this.db.deleteExpiredSessions(this.sessionTimeout);
      if (expiredCount > 0) {
        logger.info(`${expiredCount} sessões expiradas removidas`);
      }
    } catch (error) {
      logger.error('Erro ao limpar sessões:', error.message);
    }
  }

  // Limpar tentativas de login antigas
  cleanOldLoginAttempts() {
    const now = Date.now();
    const cutoff = now - this.attemptWindow;
    
    for (const [ip, attempts] of this.loginAttempts.entries()) {
      // Remover tentativas antigas que não estão mais bloqueadas
      if (attempts.lastAttempt < cutoff && (!attempts.blockedUntil || now > attempts.blockedUntil)) {
        this.loginAttempts.delete(ip);
      }
    }
  }

  // Iniciar limpeza automática de sessões e tentativas de login
  startSessionCleanup() {
    // Limpar sessões expiradas a cada hora
    setInterval(() => {
      this.cleanExpiredSessions();
    }, 60 * 60 * 1000);

    // Limpar tentativas de login antigas a cada 10 minutos
    setInterval(() => {
      this.cleanOldLoginAttempts();
    }, 10 * 60 * 1000);
  }

  // Obter estatísticas de segurança
  getSecurityStats() {
    const now = Date.now();
    const activeBlocks = Array.from(this.loginAttempts.values())
      .filter(attempt => attempt.blockedUntil && now < attempt.blockedUntil).length;
    
    return {
      totalTrackedIPs: this.loginAttempts.size,
      activeBlocks,
      maxAttemptsAllowed: this.maxLoginAttempts,
      lockoutDurationMinutes: this.lockoutDuration / 1000 / 60
    };
  }
}