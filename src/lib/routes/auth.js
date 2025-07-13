import express from 'express';
import AuthManager from '../auth.js';
import logger from '../logger.js';

const router = express.Router();

// Inicializar AuthManager quando o database estiver disponível
let authManager = null;

const initAuthManager = () => {
  if (!authManager && global.db) {
    authManager = new AuthManager(global.db);
    authManager.startSessionCleanup();
  }
  return authManager;
};

// Middleware para inicializar AuthManager
router.use((req, res, next) => {
  if (!authManager) {
    initAuthManager();
  }
  next();
});

// Função para obter IP do cliente
const getClientIP = (req) => {
  return req.headers['x-forwarded-for'] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress || 
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
         'unknown';
};

// Rota de registro
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    }
    
    // Validação básica de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Formato de e-mail inválido' });
    }
    
    // Validação de username (apenas letras, números e underscore)
    const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({ 
        error: 'Nome de usuário deve ter entre 3-20 caracteres e conter apenas letras, números e underscore' 
      });
    }
    
    const auth = initAuthManager();
    const result = await auth.register(username, email, password);
    
    res.json(result);
  } catch (error) {
    logger.error('Erro no registro:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Rota de login com proteções de segurança
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const clientIP = getClientIP(req);
    
    // Validação básica de entrada
    if (!username || !password) {
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });
    }
    
    // Validação de comprimento para prevenir ataques
    if (username.length > 100 || password.length > 100) {
      logger.warn(`Tentativa de login com dados muito longos do IP: ${clientIP}`);
      return res.status(400).json({ error: 'Dados de entrada inválidos' });
    }
    
    const auth = initAuthManager();
    
    // Verificar rate limiting antes de tentar login
    const rateLimit = auth.checkRateLimit(clientIP);
    if (!rateLimit.allowed) {
      return res.status(429).json({ 
        error: rateLimit.message,
        retryAfter: Math.ceil((rateLimit.blockedUntil - Date.now()) / 1000)
      });
    }
    
    const result = await auth.login(username, password, clientIP);
    
    // Log de sucesso (sem dados sensíveis)
    logger.info(`Login bem-sucedido para usuário: ${username} | IP: ${clientIP}`);
    
    res.json(result);
  } catch (error) {
    const clientIP = getClientIP(req);
    
    // Log de erro de segurança
    logger.warn(`Tentativa de login falhada | IP: ${clientIP} | Erro: ${error.message}`);
    
    // Determinar código de status baseado no tipo de erro
    let statusCode = 401;
    if (error.message.includes('Muitas tentativas')) {
      statusCode = 429; // Too Many Requests
    } else if (error.message.includes('não foi aprovado')) {
      statusCode = 403; // Forbidden
    }
    
    res.status(statusCode).json({ error: error.message });
  }
});

// Rota de logout
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (token) {
      const auth = initAuthManager();
      await auth.logout(token);
    }
    
    res.json({ success: true, message: 'Logout realizado com sucesso' });
  } catch (error) {
    logger.error('Erro no logout:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Rota para verificar token
router.get('/verify', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }
    
    const auth = initAuthManager();
    const session = await global.db.getSession(token);
    
    if (!session) {
      return res.status(401).json({ error: 'Sessão inválida' });
    }
    
    const decoded = auth.verifyToken(token);
    if (!decoded) {
      return res.status(403).json({ error: 'Token inválido' });
    }
    
    const user = await global.db.getUserById(decoded.id);
    if (!user || !user.approved) {
      return res.status(403).json({ error: 'Usuário não autorizado' });
    }
    
    res.json({ 
      valid: true, 
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    logger.error('Erro na verificação:', error.message);
    res.status(403).json({ error: 'Token inválido' });
  }
});

// Rota para obter estatísticas de segurança (apenas para admins)
router.get('/security-stats', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }
    
    const auth = initAuthManager();
    const decoded = auth.verifyToken(token);
    
    if (!decoded || decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    
    const stats = auth.getSecurityStats();
    res.json(stats);
  } catch (error) {
    logger.error('Erro ao obter estatísticas de segurança:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

export default router;