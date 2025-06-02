const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const dotenv = require('dotenv');
const { google } = require('googleapis');

dotenv.config();

const SYMBOL = 'BTC/USDT';
const DCA_USD_AMOUNT = 110;
const MIN_BTC_AMOUNT = 0.001;
const DCA_INTERVAL = 60 * 1000;
const LEVERAGE = 5;

const LOG_DIR = path.join(__dirname, 'logFU');
const STATE_PATH = path.join(__dirname, 'stateFU', 'state.json');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
if (!fs.existsSync(path.dirname(STATE_PATH))) fs.mkdirSync(path.dirname(STATE_PATH));

function logJSON(data) {
  const filename = path.join(LOG_DIR, `log_${moment().format('YYYY-MM-DD')}.json`);
  let logs = [];
  if (fs.existsSync(filename)) {
    try {
      logs = JSON.parse(fs.readFileSync(filename));
    } catch {
      logs = [];
    }
  }
  logs.unshift(data);
  fs.writeFileSync(filename, JSON.stringify(logs, null, 2));
  console.log(`${moment().format('YYYY-MM-DD HH:mm:ss')} | ${data.event} | ${data.message}`);
}

async function getKeyFromGDrive() {
  const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: [process.env.GOOGLE_AUTH_SCOPES],
  });
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get(
    { fileId: process.env.GOOGLE_FIELD_ID_FU, alt: 'media' },
    { responseType: 'stream' }
  );
  return new Promise((resolve, reject) => {
    let data = '';
    res.data.on('data', chunk => (data += chunk.toString()));
    res.data.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    res.data.on('error', reject);
  });
}

class BinanceFuturesDCA {
  constructor(apiKey, secret) {
    this.exchange = new ccxt.binanceusdm({
      apiKey,
      secret,
      enableRateLimit: true,
      options: { defaultType: 'future', adjustForTimeDifference: true },
    });
    this.exchange.setSandboxMode(true); // bật testnet
  }

  async setLeverage(leverage = LEVERAGE) {
    try {
      await this.exchange.setLeverage(leverage, SYMBOL);
      logJSON({ event: 'leverage_set', time: moment().format(), message: `Đòn bẩy x${leverage} đặt cho ${SYMBOL}` });
    } catch (error) {
      logJSON({ event: 'error_leverage', time: moment().format(), message: error.message });
    }
  }

  async fetchBalance() {
    return await this.exchange.fetchBalance();
  }

  async fetchPositions() {
    try {
      const positions = await this.exchange.fetchPositions([SYMBOL]);
      if (!positions || positions.length === 0) {
        logJSON({ event: 'no_positions', time: moment().format(), message: `Không có position nào được trả về cho ${SYMBOL}` });
        return null;
      }

      const activePosition = positions.find(p => p.symbol === SYMBOL && Math.abs(p.contracts || 0) > 0);

      if (!activePosition) {
        logJSON({ event: 'no_active_position', time: moment().format(), message: `Không tìm thấy position đang mở cho ${SYMBOL}` });
        return null;
      }

      return activePosition;
    } catch (e) {
      logJSON({ event: 'error_fetch_positions', time: moment().format(), message: e.message });
      return null;
    }
  }

  async getLastPrice() {
    const ticker = await this.exchange.fetchTicker(SYMBOL);
    return ticker.last;
  }

  calculatePnL(position, lastPrice) {
    const entry = position.entryPrice;
    const size = position.contracts;
    const side = position.side.toLowerCase();
    let pnl = 0;
    if (side === 'long') pnl = (lastPrice - entry) * size;
    else if (side === 'short') pnl = (entry - lastPrice) * size;
    const pct = (pnl / (entry * size)) * 100;
    return { pnl: +pnl.toFixed(2), pct: +pct.toFixed(2) };
  }

  saveState(data) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2));
  }

  async fetchOHLCV(limit = 50) {
    return await this.exchange.fetchOHLCV(SYMBOL, '1m', undefined, limit);
  }

  calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let ema = data[0];
    return data.map(price => (ema = price * k + ema * (1 - k)));
  }

  calculateRSI(data, period = 14) {
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = data[i] - data[i - 1];
      diff > 0 ? gains += diff : losses -= diff;
    }
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }

  async analyzeSignal() {
    const ohlcv = await this.fetchOHLCV(100);
    const closes = ohlcv.map(c => c[4]);
    const emaShort = this.calculateEMA(closes, 9);
    const emaLong = this.calculateEMA(closes, 21);
    const rsi = this.calculateRSI(closes, 14);

    const prevShort = emaShort[emaShort.length - 2];
    const prevLong = emaLong[emaLong.length - 2];
    const currShort = emaShort[emaShort.length - 1];
    const currLong = emaLong[emaLong.length - 1];

    if (Math.abs(currShort - currLong) < 0.0005) return 'hold';
    if (prevShort < prevLong && currShort > currLong && rsi > 45 && rsi < 70) return 'long';
    if (prevShort > prevLong && currShort < currLong && rsi < 55 && rsi > 30) return 'short';
    return 'hold';
  }

  async placeMarketOrder(side, amount) {
    return side === 'buy'
      ? await this.exchange.createMarketBuyOrder(SYMBOL, amount)
      : await this.exchange.createMarketSellOrder(SYMBOL, amount);
  }

  async placeStopLossTakeProfit(side, qty, entry) {
    const sl = 0.01;
    const tp = 0.02;
    const slPrice = side === 'long' ? entry * (1 - sl) : entry * (1 + sl);
    const tpPrice = side === 'long' ? entry * (1 + tp) : entry * (1 - tp);

    await this.exchange.createOrder(SYMBOL, 'STOP_MARKET', side === 'long' ? 'sell' : 'buy', qty, null, {
      stopPrice: +slPrice.toFixed(6),
      timeInForce: 'GTC',
    });

    await this.exchange.createOrder(SYMBOL, 'TAKE_PROFIT_MARKET', side === 'long' ? 'sell' : 'buy', qty, null, {
      stopPrice: +tpPrice.toFixed(6),
      timeInForce: 'GTC',
    });
  }

  async run() {
    const signal = await this.analyzeSignal();
    const now = moment().format();
    const logBase = { event: 'bot_run', time: now, message: `Tín hiệu: ${signal}` };
    logJSON(logBase);

    if (signal === 'hold') return;

    await this.setLeverage();
    const balance = await this.fetchBalance();
    const usdtFree = balance.free.USDT || 0;
    const lastPrice = await this.getLastPrice();
    const qty = +(DCA_USD_AMOUNT / lastPrice).toFixed(3);

    if (qty < MIN_BTC_AMOUNT || usdtFree < DCA_USD_AMOUNT) {
      logJSON({ event: 'insufficient', time: now, message: 'Không đủ điều kiện mua.' });
      return;
    }

    const order = await this.placeMarketOrder(signal === 'long' ? 'buy' : 'sell', qty);
    logJSON({ event: 'order_placed', time: now, message: `${signal} ${qty} ${SYMBOL}` });
    await this.placeStopLossTakeProfit(signal, qty, lastPrice);
    logJSON({ event: 'sl_tp', time: now, message: 'SL/TP đã đặt.' });

    const position = await this.fetchPositions();
    const pnlData = this.calculatePnL(position, lastPrice);
    const state = {
      time: now,
      signal,
      position: {
        entry: position.entryPrice,
        size: position.contracts,
        side: position.side,
        lastPrice,
        pnl: pnlData.pnl,
        pnlPct: pnlData.pct,
      },
    };
    this.saveState(state);
  }
}

(async () => {
  const { apiKey, secretKey } = await getKeyFromGDrive();
  const bot = new BinanceFuturesDCA(apiKey, secretKey);
  setInterval(() => bot.run(), DCA_INTERVAL);
  console.log('Bot Binance Futures DCA đang chạy...');
})();