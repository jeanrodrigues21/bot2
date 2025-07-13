import express from 'express';
import logger from '../logger.js';

const router = express.Router();

// Middleware de autenticação para rotas admin
const authenticate = async (req, res, next) => {
  if (!global.authManager) {
    return res.status(500).json({ error: 'AuthManager não inicializado' });
  }
  
  await global.authManager.authenticateToken(req, res, next);
};

// Middleware para admin
const requireAdmin = async (req, res, next) => {
  if (!global.authManager) {
    return res.status(500).json({ error: 'AuthManager não inicializado' });
  }
  
  await global.authManager.requireAdmin(req, res, next);
};

// Aplicar middlewares
router.use(authenticate);
router.use(requireAdmin);

// Obter usuários pendentes - CORRIGIDO: mover antes da rota genérica
router.get('/users/pending', async (req, res) => {
  try {
    const users = await global.db.getPendingUsers();
    res.json(users);
  } catch (error) {
    logger.error('Erro ao obter usuários pendentes:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter usuários ativos - CORRIGIDO: mover antes da rota genérica
router.get('/users/active', async (req, res) => {
  try {
    const users = await global.db.getActiveUsers();
    res.json(users);
  } catch (error) {
    logger.error('Erro ao obter usuários ativos:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter todos os usuários
router.get('/users', async (req, res) => {
  try {
    const users = await global.db.getAllUsers();
    res.json(users);
  } catch (error) {
    logger.error('Erro ao obter usuários:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter usuário específico
router.get('/users/:id', async (req, res) => {
  try {
    const user = await global.db.getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Remover senha da resposta
    delete user.password;
    res.json(user);
  } catch (error) {
    logger.error('Erro ao obter usuário:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Criar usuário
router.post('/users', async (req, res) => {
  try {
    const { username, email, password, role = 'user', approved = false } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
    }
    
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    }
    
    // Verificar se usuário já existe
    const existingUser = await global.db.getUserByUsernameOrEmail(username, email);
    if (existingUser) {
      return res.status(400).json({ error: 'Usuário ou e-mail já cadastrado' });
    }
    
    const hashedPassword = await global.authManager.hashPassword(password);
    
    const userId = await global.db.createUser({
      username,
      email,
      password: hashedPassword,
      role,
      approved
    });
    
    // Configuração padrão já é criada automaticamente no createUser
    
    logger.info(`Usuário criado pelo admin: ${username} (ID: ${userId})`);
    res.json({ success: true, message: 'Usuário criado com sucesso', userId });
  } catch (error) {
    logger.error('Erro ao criar usuário:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Atualizar usuário
router.put('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { username, email, password, role, approved } = req.body;
    
    // Verificar se usuário existe
    const existingUser = await global.db.getUserById(userId);
    if (!existingUser) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Preparar dados para atualização
    const updates = {};
    
    if (username && username !== existingUser.username) {
      // Verificar se novo username já existe
      const userWithUsername = await global.db.getUserByUsername(username);
      if (userWithUsername && userWithUsername.id != userId) {
        return res.status(400).json({ error: 'Nome de usuário já existe' });
      }
      updates.username = username;
    }
    
    if (email && email !== existingUser.email) {
      // Verificar se novo email já existe
      const userWithEmail = await global.db.getUserByUsernameOrEmail('', email);
      if (userWithEmail && userWithEmail.id != userId) {
        return res.status(400).json({ error: 'E-mail já cadastrado' });
      }
      updates.email = email;
    }
    
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
      }
      updates.password = await global.authManager.hashPassword(password);
    }
    
    if (role !== undefined) {
      updates.role = role;
    }
    
    if (approved !== undefined) {
      updates.approved = approved ? 1 : 0;
    }
    
    if (Object.keys(updates).length > 0) {
      await global.db.updateUser(userId, updates);
    }
    
    logger.info(`Usuário atualizado pelo admin: ${existingUser.username} (ID: ${userId})`);
    res.json({ success: true, message: 'Usuário atualizado com sucesso' });
  } catch (error) {
    logger.error('Erro ao atualizar usuário:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Excluir usuário
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    
    // Verificar se usuário existe
    const user = await global.db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Não permitir excluir o admin principal
    if (user.username === 'jean') {
      return res.status(403).json({ error: 'Não é possível excluir o administrador principal' });
    }
    
    await global.db.deleteUser(userId);
    
    logger.info(`Usuário excluído pelo admin: ${user.username} (ID: ${userId})`);
    res.json({ success: true, message: 'Usuário excluído com sucesso' });
  } catch (error) {
    logger.error('Erro ao excluir usuário:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Aprovar usuário
router.post('/users/:id/approve', async (req, res) => {
  try {
    const result = await global.authManager.approveUser(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('Erro ao aprovar usuário:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Rejeitar usuário
router.delete('/users/:id/reject', async (req, res) => {
  try {
    const result = await global.authManager.rejectUser(req.params.id);
    res.json(result);
  } catch (error) {
    logger.error('Erro ao rejeitar usuário:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Obter estatísticas
router.get('/stats', async (req, res) => {
  try {
    const allUsers = await global.db.getAllUsers();
    const activeUsers = await global.db.getActiveUsers();
    
    const stats = {
      totalUsers: allUsers.length,
      approvedUsers: allUsers.filter(u => u.approved).length,
      pendingUsers: allUsers.filter(u => !u.approved).length,
      activeUsers: activeUsers.length
    };
    
    res.json(stats);
  } catch (error) {
    logger.error('Erro ao obter estatísticas:', error.message);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

export default router;