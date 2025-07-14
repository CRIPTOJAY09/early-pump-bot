// index.js
const dotenv = require('dotenv');
dotenv.config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const winston = require('winston');

const app = express();
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_URL = process.env.EARLY_EXPLOSIONS_ENDPOINT || 'http://localhost:8080/api/explosion-candidates'; // Default para pruebas

// Configuración de logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'early_pump_bot.log' }),
    new winston.transports.Console()
  ]
});

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

const formatTokenMessage = (token) => {
  return `🚨 *Posible Explosión de Token*

*Símbolo:* ${token.symbol}
*Precio:* $${token.price.toFixed(8)}
*Cambio 5m:* ${token.change_5m}%
*Cambio 1h:* ${token.change_1h}%
*Volumen:* ${token.volume.toLocaleString()}
*Ratio de Volumen:* ${token.volumeRatio}
*RSI:* ${token.rsi}
*Volatilidad:* ${token.volatility}%
*Score de Explosión:* ${token.explosionScore}
*Nuevo Listado:* ${token.isNew ? '🆕 SÍ' : 'No'}

📊 *Recomendación:*
Acción: ${token.recommendation.action}
Comprar: $${token.recommendation.buyPrice.toFixed(8)}
Vender: $${token.recommendation.sellTarget}
Stop Loss: $${token.recommendation.stopLoss}
Confianza: ${token.recommendation.confidence}`;
};

async function fetchAndSendAlerts(retries = 2) {
  try {
    const res = await axios.get(API_URL, { timeout: 8000 });
    const tokens = res.data;
    if (!Array.isArray(tokens) || tokens.length === 0) {
      logger.warn('No tokens received from API');
      return;
    }

    const top = tokens.slice(0, 10); // Redundante pero seguro

    for (const token of top) {
      if (token.explosionScore >= 80) { // Priorizar MUY ALTA
        const msg = formatTokenMessage(token);
        await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
        logger.info(`Alert sent for ${token.symbol} with score ${token.explosionScore}`);
      } else if (token.explosionScore >= 60) { // Opcional: alertas de MEDIA
        const msg = formatTokenMessage(token).replace('🚨', '⚠️') + '\n*Nota:* Confianza moderada';
        await bot.sendMessage(TELEGRAM_CHAT_ID, msg, { parse_mode: 'Markdown' });
        logger.info(`Moderate alert sent for ${token.symbol} with score ${token.explosionScore}`);
      }
    }
  } catch (err) {
    if (retries > 0) {
      logger.warn(`Retry ${retries} for API call: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchAndSendAlerts(retries - 1);
    }
    logger.error(`Failed to fetch or send alerts after retries: ${err.message}`);
  }
}

setInterval(fetchAndSendAlerts, 1 * 60 * 1000); // Cada 1 minuto para mayor reactividad

app.get('/', (req, res) => {
  res.send('Early Pump Bot activo');
});

app.listen(PORT, () => {
  logger.info(`🚀 Microservicio Early Pump corriendo en puerto ${PORT} a las ${new Date().toLocaleString('es-ES', { timeZone: 'CET' })}`);
  fetchAndSendAlerts(); // Ejecutar al iniciar
});
