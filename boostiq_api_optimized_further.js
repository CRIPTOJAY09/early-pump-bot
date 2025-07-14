const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const NodeCache = require('node-cache');
const winston = require('winston');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

// Configuración de logging
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'boostiq_api.log' }),
    new winston.transports.Console()
  ]
});

const CONFIG = {
  BINANCE_API_KEY: process.env.BINANCE_API_KEY,
  BINANCE_BASE_URL: 'https://api.binance.com/api/v3',
  CACHE_SHORT_TTL: 120,
  CACHE_LONG_TTL: 1800,
  REQUEST_TIMEOUT: 8000,
  MIN_VOLUME_EXPLOSION: 30000,
  MIN_VOLUME_REGULAR: 20000,
  MIN_GAIN_5M: 3,
  MIN_GAIN_1H: 4,
  MIN_VOLUME_RATIO: 1.5,
  RSI_MIN: 40,
  RSI_MAX: 70,
  MIN_EXPLOSION_SCORE: 40,
  MIN_ALERT_SCORE: 40,
  MAX_CANDIDATES: 50,
  TOP_RESULTS: 10,
  RSI_PERIOD: 14,
  VOLUME_LOOKBACK_DAYS: 7,
  COMPRESSION_THRESHOLD: 0.5
};

const shortCache = new NodeCache({ stdTTL: CONFIG.CACHE_SHORT_TTL });
const longCache = new NodeCache({ stdTTL: CONFIG.CACHE_LONG_TTL });

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 100,
  message: { error: 'Rate limit exceeded. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

const POPULAR_TOKENS = new Set([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'SOLUSDT', 'DOGEUSDT',
  'MATICUSDT', 'DOTUSDT', 'TRXUSDT', 'LTCUSDT', 'LINKUSDT', 'SHIBUSDT', 'AVAXUSDT',
  'ATOMUSDT', 'NEARUSDT', 'XLMUSDT', 'ETCUSDT', 'BCHUSDT', 'HBARUSDT',
  'FILUSDT', 'SUIUSDT', 'APTUSDT', 'INJUSDT', 'IMXUSDT', 'ARBUSDT', 'RNDRUSDT',
  'TONUSDT', 'ICPUSDT', 'CROUSDT', 'NEOUSDT', 'IOTAUSDT', 'QTUMUSDT'
]);

async function fetchData(url, retries = 2) {
  try {
    const response = await axios.get(url, { timeout: CONFIG.REQUEST_TIMEOUT });
    return response.data;
  } catch (err) {
    if (retries > 0) {
      logger.warn(`Retry ${retries} for ${url}: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      return fetchData(url, retries - 1);
    }
    logger.error(`Failed fetch from ${url} after retries: ${err.message}`);
    throw err;
  }
}

async function calculateChange(symbol, timeframe) {
  try {
    const ohlcv = await fetchData(`${CONFIG.BINANCE_BASE_URL}/klines?symbol=${symbol}&interval=${timeframe}&limit=2`);
    if (ohlcv.length < 2) {
      logger.warn(`Insufficient data for ${symbol} (${timeframe})`);
      return 0;
    }
    const [prevClose, currClose] = [parseFloat(ohlcv[0][4]), parseFloat(ohlcv[1][4])];
    return ((currClose - prevClose) / prevClose * 100).toFixed(2);
  } catch (err) {
    logger.error(`Error calculating change for ${symbol} (${timeframe}): ${err.message}`);
    return 0;
  }
}

async function calculateRSI(symbol) {
  try {
    const ohlcv = await fetchData(`${CONFIG.BINANCE_BASE_URL}/klines?symbol=${symbol}&interval=5m&limit=${CONFIG.RSI_PERIOD + 1}`);
    const closes = ohlcv.map(candle => parseFloat(candle[4]));
    if (closes.length < CONFIG.RSI_PERIOD + 1) {
      logger.warn(`Insufficient data for RSI ${symbol}`);
      return 50;
    }
    const changes = closes.slice(1).map((close, i) => close - closes[i]);
    const gains = changes.map(c => c > 0 ? c : 0);
    const losses = changes.map(c => c < 0 ? -c : 0);
    const avgGain = gains.slice(-CONFIG.RSI_PERIOD).reduce((sum, g) => sum + g, 0) / CONFIG.RSI_PERIOD;
    const avgLoss = losses.slice(-CONFIG.RSI_PERIOD).reduce((sum, l) => sum + l, 0) / CONFIG.RSI_PERIOD;
    if (avgLoss === 0) return avgGain > 0 ? 100 : 50;
    const rs = avgGain / avgLoss;
    return Math.round(100 - (100 / (1 + rs)));
  } catch (err) {
    logger.error(`Error calculating RSI for ${symbol}: ${err.message}`);
    return 50;
  }
}

async function calculateVolumeRatio(symbol, currentVolume) {
  try {
    const since = Date.now() - CONFIG.VOLUME_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const ohlcv = await fetchData(`${CONFIG.BINANCE_BASE_URL}/klines?symbol=${symbol}&interval=1d&startTime=${since}`);
    const avgVolume = ohlcv.reduce((sum, candle) => sum + parseFloat(candle[5]), 0) / ohlcv.length || 1;
    return (currentVolume / avgVolume).toFixed(2);
  } catch (err) {
    logger.error(`Error calculating volume ratio for ${symbol}: ${err.message}`);
    return 1;
  }
}

async function calculateCompression(symbol) {
  try {
    const ohlcv = await fetchData(`${CONFIG.BINANCE_BASE_URL}/klines?symbol=${symbol}&interval=5m&limit=20`);
    const closes = ohlcv.map(c => parseFloat(c[4]));
    const changes = closes.slice(1).map((close, i) => (close - closes[i]) / closes[i] * 100);
    const stdDev = Math.sqrt(changes.reduce((sum, c) => sum + Math.pow(c - (changes.reduce((s, c) => s + c, 0) / changes.length), 2), 0) / changes.length);
    return stdDev < CONFIG.COMPRESSION_THRESHOLD;
  } catch (err) {
    logger.error(`Error calculating compression for ${symbol}: ${err.message}`);
    return false;
  }
}

async function calculateVolatility(symbol) {
  try {
    const ohlcv = await fetchData(`${CONFIG.BINANCE_BASE_URL}/klines?symbol=${symbol}&interval=5m&limit=20`);
    const changes = ohlcv.slice(1).map((candle, i) => ((parseFloat(candle[4]) - parseFloat(ohlcv[i][4])) / parseFloat(ohlcv[i][4]) * 100));
    const stdDev = Math.sqrt(changes.reduce((sum, c) => sum + Math.pow(c - (changes.reduce((s, c) => s + c, 0) / changes.length), 2), 0) / changes.length);
    return stdDev.toFixed(2);
  } catch (err) {
    logger.error(`Error calculating volatility for ${symbol}: ${err.message}`);
    return 10;
  }
}

async function getNewListings() {
  try {
    const cacheKey = 'newListings';
    const cached = longCache.get(cacheKey);
    if (cached) return cached;

    const listings = await fetchData(`${CONFIG.BINANCE_BASE_URL}/exchangeInfo`);
    const recentSymbols = listings.symbols
      .filter(s => s.symbol.endsWith('USDT') && !POPULAR_TOKENS.has(s.symbol))
      .sort((a, b) => new Date(b.onboardDate || 0) - new Date(a.onboardDate || 0))
      .slice(0, CONFIG.MAX_CANDIDATES)
      .map(t => t.symbol);
    longCache.set(cacheKey, recentSymbols);
    return recentSymbols;
  } catch (err) {
    logger.error(`Error fetching new listings: ${err.message}`);
    return [];
  }
}

// Top Gainers
app.get('/api/top-gainers', async (req, res) => {
  try {
    const data = await fetchData(`${CONFIG.BINANCE_BASE_URL}/ticker/24hr`);
    const filtered = data
      .filter(d => !POPULAR_TOKENS.has(d.symbol) && d.symbol.endsWith('USDT') && parseFloat(d.baseVolume) >= CONFIG.MIN_VOLUME_REGULAR)
      .sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent))
      .slice(0, CONFIG.TOP_RESULTS)
      .map(t => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        priceChangePercent: parseFloat(t.priceChangePercent)
      }));
    res.json(filtered);
  } catch (err) {
    logger.error(`Error in /top-gainers: ${err.message}`);
    res.status(500).json({ error: 'Error fetching top gainers' });
  }
});

// Candidatos a Explosión
app.get('/api/explosion-candidates', async (req, res) => {
  try {
    const cacheKey = 'explosionCandidates';
    const cached = shortCache.get(cacheKey);
    if (cached) return res.json(cached);

    const [tickerData, newListings] = await Promise.all([
      fetchData(`${CONFIG.BINANCE_BASE_URL}/ticker/24hr`),
      getNewListings()
    ]);

    const candidates = [];
    for (const t of tickerData.slice(0, CONFIG.MAX_CANDIDATES)) {
      if (!t.symbol.endsWith('USDT') || POPULAR_TOKENS.has(t.symbol)) continue;
      
      const price = parseFloat(t.lastPrice);
      const volume = parseFloat(t.baseVolume);
      if (volume < CONFIG.MIN_VOLUME_EXPLOSION) {
        logger.debug(`${t.symbol} excluded: volume ${volume} < ${CONFIG.MIN_VOLUME_EXPLOSION}`);
        continue;
      }

      const [change5m, change1h, rsi, volumeRatio, compression, volatility] = await Promise.all([
        calculateChange(t.symbol, '5m'),
        calculateChange(t.symbol, '1h'),
        calculateRSI(t.symbol),
        calculateVolumeRatio(t.symbol, volume),
        calculateCompression(t.symbol),
        calculateVolatility(t.symbol)
      ]);

      const isNew = newListings.includes(t.symbol);
      const explosionScore = Math.round(
        (parseFloat(change5m) / 25 * 100 * 0.4) + // Sin cap
        (parseFloat(change1h) / 35 * 100 * 0.2) + // Sin cap
        (parseFloat(volumeRatio) / 10 * 100 * 0.3) + // Sin cap, ajustado a 10 como máximo relativo
        ((rsi >= CONFIG.RSI_MIN && rsi <= CONFIG.RSI_MAX ? 100 : 50) * 0.1) +
        (isNew ? 20 : 0) +
        (compression ? 10 : 0) +
        20 // Bonus temporal aumentado a 20
      );

      if (
        parseFloat(change5m) >= CONFIG.MIN_GAIN_5M &&
        parseFloat(change1h) >= CONFIG.MIN_GAIN_1H &&
        parseFloat(volumeRatio) >= CONFIG.MIN_VOLUME_RATIO &&
        rsi >= CONFIG.RSI_MIN && rsi <= CONFIG.RSI_MAX &&
        explosionScore >= CONFIG.MIN_EXPLOSION_SCORE
      ) {
        const support = (price * 0.97).toFixed(8);
        const resistance = (price * 1.05).toFixed(8);
        candidates.push({
          symbol: t.symbol,
          price,
          change_5m: parseFloat(change5m),
          change_1h: parseFloat(change1h),
          volume,
          volumeRatio: parseFloat(volumeRatio),
          rsi,
          volatility,
          explosionScore,
          isNew,
          technicals: {
            rsi,
            volatility,
            volumeSpike: parseFloat(volumeRatio) >= CONFIG.MIN_VOLUME_RATIO ? parseFloat(volumeRatio).toFixed(2) : '0',
            trend: 'BULLISH',
            support,
            resistance
          },
          recommendation: {
            action: explosionScore >= 80 ? '🔥 COMPRA FUERTE' : '👀 MONITOREAR',
            buyPrice: price,
            sellTarget: (price * 1.25).toFixed(8),
            stopLoss: (price * 0.95).toFixed(8),
            confidence: explosionScore >= 80 ? 'MUY ALTA' : 'MEDIA'
          }
        });
      }
    }

    const topCandidates = candidates
      .sort((a, b) => b.explosionScore - a.explosionScore)
      .slice(0, CONFIG.TOP_RESULTS);

    if (topCandidates.length > CONFIG.TOP_RESULTS) {
      logger.warn(`Truncated ${topCandidates.length} to ${CONFIG.TOP_RESULTS} tokens`);
      topCandidates.length = CONFIG.TOP_RESULTS;
    }

    shortCache.set(cacheKey, topCandidates);
    logger.info(`Found ${topCandidates.length} explosion candidates: ${topCandidates.map(t => t.symbol).join(', ')} with scores: ${topCandidates.map(t => t.explosionScore).join(', ')}`);
    res.json(topCandidates);
  } catch (err) {
    logger.error(`Error in /explosion-candidates: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Señales Tempranas
app.get('/api/pre-explosion-signals', async (req, res) => {
  try {
    const cacheKey = 'preExplosionSignals';
    const cached = shortCache.get(cacheKey);
    if (cached) return res.json(cached);

    const [tickerData, newListings] = await Promise.all([
      fetchData(`${CONFIG.BINANCE_BASE_URL}/ticker/24hr`),
      getNewListings()
    ]);

    const alerts = [];
    for (const t of tickerData.slice(0, CONFIG.MAX_CANDIDATES)) {
      if (!t.symbol.endsWith('USDT') || POPULAR_TOKENS.has(t.symbol)) continue;
      
      const price = parseFloat(t.lastPrice);
      const volume = parseFloat(t.baseVolume);
      if (volume < CONFIG.MIN_VOLUME_REGULAR) {
        logger.debug(`${t.symbol} excluded: volume ${volume} < ${CONFIG.MIN_VOLUME_REGULAR}`);
        continue;
      }

      const [change5m, change1h, rsi, volumeRatio, compression, volatility] = await Promise.all([
        calculateChange(t.symbol, '5m'),
        calculateChange(t.symbol, '1h'),
        calculateRSI(t.symbol),
        calculateVolumeRatio(t.symbol, volume),
        calculateCompression(t.symbol),
        calculateVolatility(t.symbol)
      ]);

      const isNew = newListings.includes(t.symbol);
      const alertScore = Math.round(
        (parseFloat(change5m) / 25 * 100 * 0.4) +
        (parseFloat(change1h) / 35 * 100 * 0.2) +
        (parseFloat(volumeRatio) / 10 * 100 * 0.3) +
        ((rsi >= CONFIG.RSI_MIN && rsi <= CONFIG.RSI_MAX ? 100 : 50) * 0.1) +
        (isNew ? 20 : 0) +
        (compression ? 25 : 0) +
        20 // Bonus temporal aumentado a 20
      );

      if (
        parseFloat(change5m) >= CONFIG.MIN_GAIN_5M &&
        parseFloat(change1h) >= CONFIG.MIN_GAIN_1H &&
        parseFloat(volumeRatio) >= CONFIG.MIN_VOLUME_RATIO &&
        alertScore >= CONFIG.MIN_ALERT_SCORE
      ) {
        alerts.push({
          symbol: t.symbol,
          price,
          change_5m: parseFloat(change5m),
          change_1h: parseFloat(change1h),
          volume,
          volumeRatio: parseFloat(volumeRatio),
          rsi,
          alertScore,
          compression,
          volumeSpike: parseFloat(volumeRatio) >= CONFIG.MIN_VOLUME_RATIO,
          recommendation: {
            action: alertScore >= 80 ? '🔥 POSIBLE EXPLOSIÓN' : alertScore >= 60 ? '👀 MONITOREAR' : '❌ EVITAR',
            buyPrice: price,
            sellTarget: (price * 1.12).toFixed(8),
            stopLoss: (price * 0.92).toFixed(8),
            confidence: alertScore >= 80 ? 'ALTA' : 'MEDIA'
          }
        });
      }
    }

    const topAlerts = alerts
      .sort((a, b) => b.alertScore - a.alertScore)
      .slice(0, CONFIG.TOP_RESULTS);

    if (topAlerts.length > CONFIG.TOP_RESULTS) {
      logger.warn(`Truncated ${topAlerts.length} to ${CONFIG.TOP_RESULTS} tokens`);
      topAlerts.length = CONFIG.TOP_RESULTS;
    }

    shortCache.set(cacheKey, topAlerts);
    logger.info(`Found ${topAlerts.length} pre-explosion signals: ${topAlerts.map(t => t.symbol).join(', ')} with scores: ${topAlerts.map(t => t.alertScore).join(', ')}`);
    res.json(topAlerts);
  } catch (err) {
    logger.error(`Error in /pre-explosion-signals: ${err.message}`);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Nuevos Listings
app.get('/api/new-listings', async (req, res) => {
  try {
    const listings = await getNewListings();
    res.json(listings.map(symbol => ({ symbol })));
  } catch (err) {
    logger.error(`Error in /new-listings: ${err.message}`);
    res.status(500).json({ error: 'Error fetching new listings' });
  }
});

// Análisis Individual
app.get('/api/analysis/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await fetchData(`${CONFIG.BINANCE_BASE_URL}/ticker/24hr?symbol=${symbol}`);
    const price = parseFloat(data.lastPrice);
    const volume = parseFloat(data.baseVolume);

    const [change5m, change1h, rsi, volumeRatio, compression, volatility] = await Promise.all([
      calculateChange(symbol, '5m'),
      calculateChange(symbol, '1h'),
      calculateRSI(symbol),
      calculateVolumeRatio(symbol, volume),
      calculateCompression(symbol),
      calculateVolatility(symbol)
    ]);

    const explosionScore = Math.round(
      (parseFloat(change5m) / 25 * 100 * 0.4) +
      (parseFloat(change1h) / 35 * 100 * 0.2) +
      (parseFloat(volumeRatio) / 10 * 100 * 0.3) +
      ((rsi >= CONFIG.RSI_MIN && rsi <= CONFIG.RSI_MAX ? 100 : 50) * 0.1) +
      (compression ? 10 : 0)
    );

    res.json({
      symbol,
      price,
      change_5m: parseFloat(change5m),
      change_1h: parseFloat(change1h),
      volume,
      volumeRatio: parseFloat(volumeRatio),
      rsi,
      volatility,
      explosionScore,
      recommendation: {
        action: explosionScore >= 80 ? '🔥 COMPRA FUERTE' : '👀 MONITOREAR',
        buyPrice: price,
        sellTarget: (price * 1.25).toFixed(8),
        stopLoss: (price * 0.95).toFixed(8),
        confidence: explosionScore >= 80 ? 'MUY ALTA' : 'MEDIA'
      }
    });
  } catch (err) {
    logger.error(`Error in /analysis/${req.params.symbol}: ${err.message}`);
    res.status(500).json({ error: 'Error in individual analysis' });
  }
});

// Servidor activo
app.listen(PORT, () => {
  logger.info(`🚀 BoostIQ API running on port ${PORT} at ${new Date().toLocaleString('es-ES', { timeZone: 'CET' })}`);
});
