import logger from '../logger.js';

/**
 * Módulo de Estratégias de Trading
 * 
 * Contém todas as estratégias de compra e venda do bot.
 * Mantém a lógica original funcionando e adiciona novas estratégias.
 */
export default class TradingStrategies {
  constructor(config) {
    this.config = config;
    
    // Configurações das estratégias
    this.strategies = {
      // Estratégia original: comprar na mínima histórica
      buyAtLow: {
        enabled: true,
        name: 'Compra na Mínima Histórica'
      },
      
      // Nova estratégia: comprar na queda da máxima
      buyOnDrop: {
        enabled: true,
        name: 'Compra na Queda da Máxima',
        dropPercentage: config.buyOnDropPercent || 0.7 // Configurável pelo usuário
      }
    };
  }

  /**
   * ESTRATÉGIA ORIGINAL - Comprar na mínima histórica
   * Esta é a lógica que já estava funcionando no tradingBot.js
   */
  shouldBuyAtLow(priceHistory, currentPrice, dailyLow, dailyHigh, lastBuyTime) {
    try {
      // Verificações básicas (lógica original mantida)
      if (priceHistory.length < this.config.minHistoryForAnalysis) {
        return { shouldBuy: false, reason: 'Histórico insuficiente' };
      }

      if (dailyHigh === dailyLow) {
        return { shouldBuy: false, reason: 'Sem variação de preço' };
      }

      // Verificar variação diária mínima (lógica original)
      const dailyVariation = ((dailyHigh - dailyLow) / dailyLow) * 100;
      if (dailyVariation < this.config.minPriceChange) {
        return { shouldBuy: false, reason: `Variação diária insuficiente: ${dailyVariation.toFixed(2)}%` };
      }

      // Verificar se está próximo da mínima diária (lógica original)
      const priceFromLow = ((currentPrice - dailyLow) / dailyLow) * 100;
      
      if (priceFromLow <= this.config.buyThresholdFromLow) {
        // Verificar tendência de alta recente (lógica original)
        const recentPrices = priceHistory
          .slice(-this.config.recentTrendWindow)
          .map(p => p.price);
        
        if (recentPrices.length >= this.config.recentTrendWindow) {
          const halfLength = Math.floor(recentPrices.length / 2);
          const firstHalfAvg = recentPrices.slice(0, halfLength).reduce((a, b) => a + b, 0) / halfLength;
          const secondHalfAvg = recentPrices.slice(halfLength).reduce((a, b) => a + b, 0) / (recentPrices.length - halfLength);
          
          if (secondHalfAvg > firstHalfAvg) {
            // Verificar cooldown (lógica original)
            if (lastBuyTime) {
              const timeSinceLastBuy = (Date.now() - lastBuyTime.getTime()) / 1000;
              
              if (timeSinceLastBuy < this.config.buyCooldownSeconds) {
                return { 
                  shouldBuy: false, 
                  reason: `Cooldown ativo: ${Math.ceil(this.config.buyCooldownSeconds - timeSinceLastBuy)}s restantes` 
                };
              }
            }
            
            return {
              shouldBuy: true,
              strategy: 'buyAtLow',
              reason: 'Compra na mínima histórica',
              details: {
                priceFromLow: priceFromLow.toFixed(2),
                dailyVariation: dailyVariation.toFixed(2),
                trendDirection: 'alta'
              }
            };
          }
        }
      }
      
      return { shouldBuy: false, reason: 'Condições não atendidas para compra na mínima' };
      
    } catch (error) {
      logger.error('Erro na estratégia de compra na mínima:', error);
      return { shouldBuy: false, reason: 'Erro na análise' };
    }
  }

  /**
   * NOVA ESTRATÉGIA - Comprar na queda da máxima
   * Compra quando o preço cai X% da máxima recente
   */
  shouldBuyOnDrop(priceHistory, currentPrice, dailyLow, dailyHigh, lastBuyTime) {
    try {
      if (!this.strategies.buyOnDrop.enabled) {
        return { shouldBuy: false, reason: 'Estratégia desabilitada' };
      }

      // Verificações básicas
      if (priceHistory.length < this.config.minHistoryForAnalysis) {
        return { shouldBuy: false, reason: 'Histórico insuficiente' };
      }

      if (dailyHigh === dailyLow) {
        return { shouldBuy: false, reason: 'Sem variação de preço' };
      }

      // Calcular a queda da máxima
      const dropFromHigh = ((dailyHigh - currentPrice) / dailyHigh) * 100;
      const requiredDrop = this.strategies.buyOnDrop.dropPercentage;

      if (dropFromHigh >= requiredDrop) {
        // Verificar se não está muito próximo da mínima (evitar comprar no fundo)
        const priceFromLow = ((currentPrice - dailyLow) / dailyLow) * 100;
        
        // Se estiver muito próximo da mínima, deixar a estratégia original atuar
        if (priceFromLow <= this.config.buyThresholdFromLow) {
          return { shouldBuy: false, reason: 'Muito próximo da mínima - estratégia original deve atuar' };
        }

        // Verificar cooldown
        if (lastBuyTime) {
          const timeSinceLastBuy = (Date.now() - lastBuyTime.getTime()) / 1000;
          
          if (timeSinceLastBuy < this.config.buyCooldownSeconds) {
            return { 
              shouldBuy: false, 
              reason: `Cooldown ativo: ${Math.ceil(this.config.buyCooldownSeconds - timeSinceLastBuy)}s restantes` 
            };
          }
        }

        // Verificar tendência (opcional - pode ser mais flexível que a estratégia original)
        const recentPrices = priceHistory
          .slice(-Math.min(5, this.config.recentTrendWindow)) // Janela menor para ser mais responsivo
          .map(p => p.price);

        if (recentPrices.length >= 3) {
          // Verificar se não está em queda livre (proteção adicional)
          const priceChange = ((recentPrices[recentPrices.length - 1] - recentPrices[0]) / recentPrices[0]) * 100;
          
          // Se estiver caindo mais de 2% muito rapidamente, aguardar estabilização
          if (priceChange < -2.0) {
            return { shouldBuy: false, reason: 'Queda muito acentuada - aguardando estabilização' };
          }
        }

        return {
          shouldBuy: true,
          strategy: 'buyOnDrop',
          reason: 'Compra na queda da máxima',
          details: {
            dropFromHigh: dropFromHigh.toFixed(2),
            requiredDrop: requiredDrop.toFixed(2),
            currentPrice: currentPrice,
            dailyHigh: dailyHigh
          }
        };
      }

      return { 
        shouldBuy: false, 
        reason: `Queda insuficiente: ${dropFromHigh.toFixed(2)}% < ${requiredDrop}%` 
      };
      
    } catch (error) {
      logger.error('Erro na estratégia de compra na queda:', error);
      return { shouldBuy: false, reason: 'Erro na análise' };
    }
  }

  /**
   * Método principal para verificar se deve comprar
   * Combina todas as estratégias de compra
   */
  shouldBuy(priceHistory, currentPrice, dailyLow, dailyHigh, lastBuyTime) {
    try {
      // Tentar estratégia original primeiro (prioridade)
      const buyAtLowResult = this.shouldBuyAtLow(priceHistory, currentPrice, dailyLow, dailyHigh, lastBuyTime);
      
      if (buyAtLowResult.shouldBuy) {
        logger.info(`✅ Estratégia Original ativada: ${buyAtLowResult.reason}`);
        return buyAtLowResult;
      }

      // Se a estratégia original não ativar, tentar a nova estratégia
      const buyOnDropResult = this.shouldBuyOnDrop(priceHistory, currentPrice, dailyLow, dailyHigh, lastBuyTime);
      
      if (buyOnDropResult.shouldBuy) {
        logger.info(`✅ Nova Estratégia ativada: ${buyOnDropResult.reason}`);
        return buyOnDropResult;
      }

      // Se nenhuma estratégia ativar, retornar o motivo da estratégia original
      return buyAtLowResult;
      
    } catch (error) {
      logger.error('Erro ao avaliar estratégias de compra:', error);
      return { shouldBuy: false, reason: 'Erro na análise das estratégias' };
    }
  }

  /**
   * LÓGICA DE VENDA - Mantida igual à original
   * A venda segue a mesma lógica para ambas as estratégias
   */
  shouldSell(position, currentPrice) {
    try {
      const buyPrice = position.buyPrice;
      
      // Calcular lucro/prejuízo (lógica original mantida)
      const sellAmount = position.quantity;
      const fees = this.calculateFees(buyPrice * position.quantity) + 
                   this.calculateFees(currentPrice * sellAmount);
      const netProfit = (currentPrice * sellAmount) - (buyPrice * position.quantity) - fees;
      const profitPercent = (netProfit / (buyPrice * position.quantity)) * 100;
      
      // Verificar meta de lucro (lógica original)
      if (profitPercent >= this.config.dailyProfitTarget) {
        logger.info(`🎯 Meta de lucro atingida: ${profitPercent.toFixed(2)}% >= ${this.config.dailyProfitTarget}%`);
        return { shouldSell: true, reason: 'profit_target', profitPercent };
      }
      
      // Verificar stop loss (lógica original)
      const lossPercent = ((buyPrice - currentPrice) / buyPrice) * 100;
      if (lossPercent >= this.config.stopLossPercent) {
        logger.warn(`🛑 Stop loss ativado! Perda: ${lossPercent.toFixed(2)}%`);
        return { shouldSell: true, reason: 'stop_loss', lossPercent };
      }
      
      return { shouldSell: false };
      
    } catch (error) {
      logger.error('Erro ao verificar critérios de venda:', error);
      return { shouldSell: false };
    }
  }

  /**
   * Calcular taxas (lógica original mantida)
   */
  calculateFees(amount, isMaker = false) {
    const feeRate = isMaker ? this.config.makerFee : this.config.takerFee;
    return amount * feeRate;
  }

  /**
   * Atualizar configurações das estratégias
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    
    // Atualizar configuração específica da nova estratégia
    if (newConfig.buyOnDropPercent !== undefined) {
      this.strategies.buyOnDrop.dropPercentage = newConfig.buyOnDropPercent;
      logger.info(`Estratégia de queda atualizada: ${newConfig.buyOnDropPercent}%`);
    }
  }

  /**
   * Habilitar/desabilitar estratégias
   */
  enableStrategy(strategyName, enabled = true) {
    if (this.strategies[strategyName]) {
      this.strategies[strategyName].enabled = enabled;
      logger.info(`Estratégia ${strategyName} ${enabled ? 'habilitada' : 'desabilitada'}`);
    }
  }

  /**
   * Obter status das estratégias
   */
  getStrategiesStatus() {
    return {
      strategies: this.strategies,
      config: {
        buyThresholdFromLow: this.config.buyThresholdFromLow,
        buyOnDropPercent: this.config.buyOnDropPercent || 0.7,
        dailyProfitTarget: this.config.dailyProfitTarget,
        stopLossPercent: this.config.stopLossPercent
      }
    };
  }
}