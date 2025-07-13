import axios from 'axios';
import crypto from 'crypto';
import logger from './logger.js';

export default class BinanceAPI {
  constructor(config) {
    this.config = config;
    this.rateLimitInfo = {
      weight: 0,
      orders: 0,
      resetTime: Date.now() + 60000
    };
    
    this.client = axios.create({
      baseURL: config.baseUrl,
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'User-Agent': 'TradingBot/1.0'
      },
      timeout: 15000
    });
    
    this.client.interceptors.request.use(
      (config) => {
        logger.debug(`Fazendo requisição: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error('Erro na requisição:', error);
        return Promise.reject(error);
      }
    );
    
    this.client.interceptors.response.use(
      (response) => {
        // Atualizar informações de rate limit
        if (response.headers['x-mbx-used-weight']) {
          this.rateLimitInfo.weight = parseInt(response.headers['x-mbx-used-weight']);
        }
        if (response.headers['x-mbx-order-count']) {
          this.rateLimitInfo.orders = parseInt(response.headers['x-mbx-order-count']);
        }
        
        logger.debug(`Resposta recebida: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        const status = error.response?.status;
        const url = error.config?.url;
        const data = error.response?.data;
        
        logger.error(`Erro na resposta: ${status} ${url}`, {
          status,
          data: typeof data === 'string' ? data.substring(0, 500) : data
        });
        
        // Tratamento específico para erros 403
        if (status === 403) {
          this._handle403Error(error);
        }
        
        return Promise.reject(error);
      }
    );
  }
  
  _handle403Error(error) {
    const errorData = error.response?.data;
    
    if (typeof errorData === 'string' && errorData.includes('CloudFront')) {
      logger.error('Erro 403: Requisição bloqueada pelo CloudFront da Binance. Possíveis causas:');
      logger.error('1. IP bloqueado ou não autorizado');
      logger.error('2. Muitas requisições (rate limit)');
      logger.error('3. Região geográfica restrita');
      logger.error('4. Credenciais da API incorretas ou sem permissões');
    } else if (typeof errorData === 'object' && errorData.code) {
      logger.error(`Erro 403 da API Binance: ${errorData.msg} (Código: ${errorData.code})`);
      
      switch (errorData.code) {
        case -2014:
          logger.error('API Key inválida ou formato incorreto');
          break;
        case -1022:
          logger.error('Assinatura inválida - verifique a SECRET_KEY');
          break;
        case -2015:
          logger.error('API Key inválida, IP não autorizado ou permissões insuficientes');
          break;
        default:
          logger.error('Verifique suas credenciais da API e permissões na Binance');
      }
    } else {
      logger.error('Erro 403: Acesso negado. Verifique:');
      logger.error('1. Credenciais da API (BINANCE_API_KEY e BINANCE_SECRET_KEY)');
      logger.error('2. Permissões da API Key na Binance');
      logger.error('3. Restrições de IP na sua conta Binance');
      logger.error('4. Se a API Key está ativa e não expirou');
    }
  }
  
  _generateSignature(queryString) {
    return crypto
      .createHmac('sha256', this.config.apiSecret)
      .update(queryString)
      .digest('hex');
  }
  
  async _makeRequest(method, endpoint, params = {}, signed = false) {
    try {
      // Verificar rate limit
      if (this.rateLimitInfo.weight > 1000) {
        logger.warn('Rate limit próximo do limite, aguardando...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      const config = {
        method: method.toLowerCase(),
        url: endpoint
      };
      
      if (signed) {
        params.timestamp = Date.now();
        const queryString = new URLSearchParams(params).toString();
        params.signature = this._generateSignature(queryString);
      }
      
      // CORREÇÃO PRINCIPAL: Para requisições POST, enviar parâmetros no corpo da requisição
      if (method.toUpperCase() === 'GET') {
        config.params = params;
      } else if (method.toUpperCase() === 'POST') {
        // Para POST, enviar como form-urlencoded no corpo da requisição
        config.data = new URLSearchParams(params).toString();
        config.headers = {
          'Content-Type': 'application/x-www-form-urlencoded'
        };
      } else if (method.toUpperCase() === 'DELETE') {
        // Para DELETE, enviar como query parameters
        config.params = params;
      } else {
        config.data = params;
      }
      
      const response = await this.client(config);
      return response.data;
    } catch (error) {
      logger.error(`Erro na requisição ${method} ${endpoint}:`, error.message);
      
      if (error.response?.status === 403) {
        logger.error('DIAGNÓSTICO: Erro 403 detectado. Execute as seguintes verificações:');
        logger.error('1. Faça login na Binance e vá em "API Management"');
        logger.error('2. Verifique se sua API Key tem as permissões necessárias');
        logger.error('3. Confirme se o IP está na whitelist (se configurado)');
        logger.error('4. Teste suas credenciais em: https://testnet.binance.vision/ (testnet)');
      }
      
      return null;
    }
  }
  
  async testConnection() {
    logger.info('Testando conexão com a API Binance...');
    
    try {
      // Primeiro, testar endpoint público (sem autenticação)
      const serverTime = await this._makeRequest('GET', '/api/v3/time');
      if (!serverTime) {
        logger.error('Falha ao conectar com a API Binance (endpoint público)');
        return false;
      }
      
      logger.info('Conexão com API pública OK');
      
      // Testar endpoint que requer autenticação
      const accountInfo = await this.getAccountInfo();
      if (!accountInfo) {
        logger.error('Falha na autenticação com a API Binance');
        logger.error('Verifique suas credenciais e permissões da API');
        return false;
      }
      
      logger.info('Autenticação com API OK');
      return true;
      
    } catch (error) {
      logger.error('Erro no teste de conexão:', error.message);
      return false;
    }
  }
  
  async getAccountInfo() {
    return await this._makeRequest('GET', '/api/v3/account', {}, true);
  }
  
  async getSymbolInfo(symbol = null) {
    const response = await this._makeRequest('GET', '/api/v3/exchangeInfo');
    if (!response?.symbols) return null;
    
    const targetSymbol = symbol || this.config.symbol;
    const symbolInfo = response.symbols.find(s => s.symbol === targetSymbol);
    
    if (symbolInfo) {
      // Extrair informações importantes dos filtros
      const lotSizeFilter = symbolInfo.filters?.find(f => f.filterType === 'LOT_SIZE');
      const priceFilter = symbolInfo.filters?.find(f => f.filterType === 'PRICE_FILTER');
      const notionalFilter = symbolInfo.filters?.find(f => f.filterType === 'NOTIONAL') || 
                            symbolInfo.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
      
      return {
        ...symbolInfo,
        lotSize: lotSizeFilter ? {
          minQty: parseFloat(lotSizeFilter.minQty),
          maxQty: parseFloat(lotSizeFilter.maxQty),
          stepSize: parseFloat(lotSizeFilter.stepSize)
        } : null,
        priceFilter: priceFilter ? {
          minPrice: parseFloat(priceFilter.minPrice),
          maxPrice: parseFloat(priceFilter.maxPrice),
          tickSize: parseFloat(priceFilter.tickSize)
        } : null,
        notional: notionalFilter ? {
          minNotional: parseFloat(notionalFilter.minNotional || notionalFilter.minNotional),
          maxNotional: parseFloat(notionalFilter.maxNotional || notionalFilter.maxNotional || Infinity)
        } : null
      };
    }
    
    return null;
  }
  
  // NOVO: Obter informações de múltiplos símbolos
  async getMultipleSymbolsInfo(symbols) {
    const response = await this._makeRequest('GET', '/api/v3/exchangeInfo');
    if (!response?.symbols) return {};
    
    const symbolsInfo = {};
    
    symbols.forEach(symbol => {
      const symbolInfo = response.symbols.find(s => s.symbol === symbol);
      if (symbolInfo) {
        const lotSizeFilter = symbolInfo.filters?.find(f => f.filterType === 'LOT_SIZE');
        const priceFilter = symbolInfo.filters?.find(f => f.filterType === 'PRICE_FILTER');
        const notionalFilter = symbolInfo.filters?.find(f => f.filterType === 'NOTIONAL') || 
                              symbolInfo.filters?.find(f => f.filterType === 'MIN_NOTIONAL');
        
        symbolsInfo[symbol] = {
          ...symbolInfo,
          lotSize: lotSizeFilter ? {
            minQty: parseFloat(lotSizeFilter.minQty),
            maxQty: parseFloat(lotSizeFilter.maxQty),
            stepSize: parseFloat(lotSizeFilter.stepSize)
          } : null,
          priceFilter: priceFilter ? {
            minPrice: parseFloat(priceFilter.minPrice),
            maxPrice: parseFloat(priceFilter.maxPrice),
            tickSize: parseFloat(priceFilter.tickSize)
          } : null,
          notional: notionalFilter ? {
            minNotional: parseFloat(notionalFilter.minNotional || notionalFilter.minNotional),
            maxNotional: parseFloat(notionalFilter.maxNotional || notionalFilter.maxNotional || Infinity)
          } : null
        };
      }
    });
    
    return symbolsInfo;
  }
  
  async get24hrTicker(symbol = null) {
    const params = {};
    if (symbol) {
      params.symbol = symbol;
    } else {
      params.symbol = this.config.symbol;
    }
    
    return await this._makeRequest('GET', '/api/v3/ticker/24hr', params);
  }
  
  // CORRIGIDO: Obter tickers de múltiplas moedas com dados completos
  async getMultiple24hrTickers(symbols) {
    try {
      const tickers = await this._makeRequest('GET', '/api/v3/ticker/24hr');
      if (!tickers || !Array.isArray(tickers)) return {};
      
      const result = {};
      symbols.forEach(symbol => {
        const ticker = tickers.find(t => t.symbol === symbol);
        if (ticker) {
          result[symbol] = {
            symbol: ticker.symbol,
            price: parseFloat(ticker.lastPrice),
            priceChange: parseFloat(ticker.priceChange),
            priceChangePercent: parseFloat(ticker.priceChangePercent),
            highPrice: parseFloat(ticker.highPrice),
            lowPrice: parseFloat(ticker.lowPrice),
            volume: parseFloat(ticker.volume),
            quoteVolume: parseFloat(ticker.quoteVolume),
            openPrice: parseFloat(ticker.openPrice),
            prevClosePrice: parseFloat(ticker.prevClosePrice),
            count: parseInt(ticker.count),
            openTime: parseInt(ticker.openTime),
            closeTime: parseInt(ticker.closeTime)
          };
        }
      });
      
      return result;
    } catch (error) {
      logger.error('Erro ao obter múltiplos tickers:', error);
      return {};
    }
  }
  
  async getCurrentPrice(symbol = null) {
    const targetSymbol = symbol || this.config.symbol;
    const response = await this._makeRequest('GET', '/api/v3/ticker/price', {
      symbol: targetSymbol
    });
    
    if (!response) {
      logger.error(`Não foi possível obter o preço atual de ${targetSymbol}`);
      return 0;
    }
    
    return response?.price ? parseFloat(response.price) : 0;
  }
  
  // CORRIGIDO: Obter preços de múltiplas moedas
  async getMultiplePrices(symbols) {
    try {
      const prices = await this._makeRequest('GET', '/api/v3/ticker/price');
      if (!prices || !Array.isArray(prices)) return {};
      
      const result = {};
      symbols.forEach(symbol => {
        const priceData = prices.find(p => p.symbol === symbol);
        if (priceData) {
          result[symbol] = parseFloat(priceData.price);
        }
      });
      
      return result;
    } catch (error) {
      logger.error('Erro ao obter múltiplos preços:', error);
      return {};
    }
  }
  
  // Função para ajustar quantidade conforme as regras do símbolo
  adjustQuantity(quantity, symbolInfo) {
    if (!symbolInfo?.lotSize) {
      logger.warn('Informações de LOT_SIZE não disponíveis, usando quantidade original');
      return quantity;
    }
    
    const { minQty, stepSize } = symbolInfo.lotSize;
    
    // Ajustar para o stepSize
    let adjustedQty = Math.floor(quantity / stepSize) * stepSize;
    
    // Garantir que está acima do mínimo
    if (adjustedQty < minQty) {
      logger.warn(`Quantidade ${adjustedQty} menor que o mínimo ${minQty}`);
      return 0; // Não pode fazer a ordem
    }
    
    // Arredondar para o número correto de casas decimais
    const decimals = stepSize.toString().split('.')[1]?.length || 0;
    adjustedQty = parseFloat(adjustedQty.toFixed(decimals));
    
    logger.debug(`Quantidade ajustada: ${quantity} -> ${adjustedQty} (stepSize: ${stepSize}, minQty: ${minQty})`);
    
    return adjustedQty;
  }
  
  // Função para ajustar preço conforme as regras do símbolo
  adjustPrice(price, symbolInfo) {
    if (!symbolInfo?.priceFilter) {
      logger.warn('Informações de PRICE_FILTER não disponíveis, usando preço original');
      return price;
    }
    
    const { tickSize } = symbolInfo.priceFilter;
    
    // Ajustar para o tickSize
    let adjustedPrice = Math.round(price / tickSize) * tickSize;
    
    // Arredondar para o número correto de casas decimais
    const decimals = tickSize.toString().split('.')[1]?.length || 0;
    adjustedPrice = parseFloat(adjustedPrice.toFixed(decimals));
    
    logger.debug(`Preço ajustado: ${price} -> ${adjustedPrice} (tickSize: ${tickSize})`);
    
    return adjustedPrice;
  }
  
  async placeOrder(side, quantity, price = null, orderType = 'MARKET', symbol = null) {
    const targetSymbol = symbol || this.config.symbol;
    
    // Obter informações do símbolo para ajustes
    const symbolInfo = await this.getSymbolInfo(targetSymbol);
    
    if (!symbolInfo) {
      throw new Error(`Não foi possível obter informações do símbolo ${targetSymbol}`);
    }
    
    // Ajustar quantidade conforme as regras
    const adjustedQuantity = this.adjustQuantity(quantity, symbolInfo);
    
    if (adjustedQuantity <= 0) {
      throw new Error(`Quantidade inválida após ajustes: ${adjustedQuantity}`);
    }
    
    const params = {
      symbol: targetSymbol,
      side: side.toUpperCase(),
      type: orderType.toUpperCase(),
      quantity: adjustedQuantity.toString()
    };
    
    if (orderType.toUpperCase() === 'LIMIT') {
      const adjustedPrice = this.adjustPrice(price, symbolInfo);
      params.price = adjustedPrice.toString();
      params.timeInForce = 'GTC';
    }
    
    // Verificar valor mínimo da ordem (notional)
    if (symbolInfo.notional && orderType.toUpperCase() === 'MARKET') {
      const currentPrice = await this.getCurrentPrice(targetSymbol);
      const orderValue = adjustedQuantity * currentPrice;
      
      if (orderValue < symbolInfo.notional.minNotional) {
        throw new Error(`Valor da ordem ${orderValue.toFixed(2)} USDT menor que o mínimo ${symbolInfo.notional.minNotional} USDT`);
      }
    }
    
    // Log para debug
    logger.info(`Executando ordem ${side}: ${adjustedQuantity} ${targetSymbol} ${orderType}`);
    logger.debug('Parâmetros da ordem:', params);
    
    return await this._makeRequest('POST', '/api/v3/order', params, true);
  }
  
  async getOpenOrders(symbol = null) {
    const params = {};
    if (symbol) {
      params.symbol = symbol;
    } else {
      params.symbol = this.config.symbol;
    }
    
    const response = await this._makeRequest('GET', '/api/v3/openOrders', params, true);
    return response || [];
  }
  
  async cancelOrder(orderId, symbol = null) {
    const targetSymbol = symbol || this.config.symbol;
    return await this._makeRequest('DELETE', '/api/v3/order', {
      symbol: targetSymbol,
      orderId: orderId
    }, true);
  }
  
  async getAssetBalance(asset) {
    const accountInfo = await this.getAccountInfo();
    if (!accountInfo?.balances) return 0;
    
    const balance = accountInfo.balances.find(b => b.asset === asset);
    return balance ? parseFloat(balance.free) : 0;
  }
  
  async getBtcBalance() {
    return await this.getAssetBalance('BTC');
  }
  
  async getUsdtBalance() {
    return await this.getAssetBalance('USDT');
  }
  
  // NOVO: Obter saldo de uma moeda específica baseada no símbolo
  async getBaseAssetBalance(symbol) {
    // Extrair o ativo base do símbolo (ex: BTC de BTCUSDT)
    const baseAsset = symbol.replace('USDT', '').replace('BUSD', '').replace('BNB', '');
    return await this.getAssetBalance(baseAsset);
  }
  
  // Nova função para obter todos os saldos de uma vez
  async getAllBalances() {
    const accountInfo = await this.getAccountInfo();
    if (!accountInfo?.balances) return {};
    
    const balances = {};
    accountInfo.balances.forEach(balance => {
      const free = parseFloat(balance.free);
      const locked = parseFloat(balance.locked);
      
      if (free > 0 || locked > 0) {
        balances[balance.asset] = {
          free,
          locked,
          total: free + locked
        };
      }
    });
    
    return balances;
  }
  
  // Função para obter histórico de ordens
  async getOrderHistory(limit = 10, symbol = null) {
    const targetSymbol = symbol || this.config.symbol;
    return await this._makeRequest('GET', '/api/v3/allOrders', {
      symbol: targetSymbol,
      limit: limit
    }, true);
  }
  
  // Função para obter detalhes de uma ordem específica
  async getOrder(orderId, symbol = null) {
    const targetSymbol = symbol || this.config.symbol;
    return await this._makeRequest('GET', '/api/v3/order', {
      symbol: targetSymbol,
      orderId: orderId
    }, true);
  }
  
  // NOVO: Verificar se uma moeda está disponível para trading
  async isSymbolTradingEnabled(symbol) {
    try {
      const symbolInfo = await this.getSymbolInfo(symbol);
      return symbolInfo && symbolInfo.status === 'TRADING';
    } catch (error) {
      logger.error(`Erro ao verificar status do símbolo ${symbol}:`, error);
      return false;
    }
  }
  
  // CORRIGIDO: Obter top moedas por volume com dados completos
  async getTopVolumeCoins(limit = 10) {
    try {
      const tickers = await this._makeRequest('GET', '/api/v3/ticker/24hr');
      if (!tickers || !Array.isArray(tickers)) return [];
      
      // Filtrar apenas pares USDT e ordenar por volume
      const usdtPairs = tickers
        .filter(ticker => ticker.symbol.endsWith('USDT'))
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, limit);
      
      return usdtPairs.map(ticker => ({
        symbol: ticker.symbol,
        volume: parseFloat(ticker.quoteVolume),
        price: parseFloat(ticker.lastPrice),
        priceChangePercent: parseFloat(ticker.priceChangePercent),
        highPrice: parseFloat(ticker.highPrice),
        lowPrice: parseFloat(ticker.lowPrice),
        openPrice: parseFloat(ticker.openPrice),
        count: parseInt(ticker.count)
      }));
    } catch (error) {
      logger.error('Erro ao obter top moedas por volume:', error);
      return [];
    }
  }
}