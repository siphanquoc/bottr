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

const LOG_DIR = path.join(__dirname, 'logFU');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

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

// Lấy API key/secret từ Google Drive
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
    this.exchange = new ccxt.binance({
        apiKey: apiKey,
        secret: secret,
        enableRateLimit: true,
        options: {
            defaultType: 'future',
            adjustForTimeDifference: true,
        },
        urls: {
            api: {
                public: 'https://testnet.binancefuture.com/fapi/v1',
                private: 'https://testnet.binancefuture.com/fapi/v1',
            }
        }
    });
    this.exchange.setSandboxMode(true); // testnet mode
  }

  async fetchBalance() {
    return await this.exchange.fetchBalance();
  }

  async fetchPositions() {
    const positions = await this.exchange.fetchPositions([SYMBOL]);
    if (!positions || positions.length === 0) return null;
    return positions.find(p => p.symbol === SYMBOL && p.contracts > 0) || null;
  }

  async getLastPrice() {
    const ticker = await this.exchange.fetchTicker(SYMBOL);
    return ticker.last;
  }

  calculateEMA(data, period) {
    const k = 2 / (period + 1);
    let emaArray = [];
    let ema = data[0];
    emaArray.push(ema);
    for (let i = 1; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
      emaArray.push(ema);
    }
    return emaArray;
  }

  calculateRSI(data, period = 14) {
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = data[i] - data[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rs = avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    return rsi;
  }

  async fetchOHLCV(limit = 50) {
    return await this.exchange.fetchOHLCV(SYMBOL, '1m', undefined, limit);
  }

  async analyzeSignal() {
    const ohlcv = await this.fetchOHLCV(50);
    const closes = ohlcv.map(c => c[4]);
    const emaShort = this.calculateEMA(closes, 9);
    const emaLong = this.calculateEMA(closes, 21);
    const rsi = this.calculateRSI(closes, 14);

    const prevEmaShort = emaShort[emaShort.length - 2];
    const prevEmaLong = emaLong[emaLong.length - 2];
    const currEmaShort = emaShort[emaShort.length - 1];
    const currEmaLong = emaLong[emaLong.length - 1];

    if (prevEmaShort < prevEmaLong && currEmaShort > currEmaLong && rsi < 70) return 'long';
    if (prevEmaShort > prevEmaLong && currEmaShort < currEmaLong && rsi > 30) return 'short';
    return 'hold';
  }

  async placeMarketOrder(side, amount) {
    if (side === 'buy') return await this.exchange.createMarketBuyOrder(SYMBOL, amount);
    else if (side === 'sell') return await this.exchange.createMarketSellOrder(SYMBOL, amount);
  }

  async placeStopLossTakeProfit(positionSide, quantity, entryPrice) {
    const slPct = 0.01; // 1%
    const tpPct = 0.02; // 2%
    let stopPrice, takeProfitPrice;

    if (positionSide === 'long') {
      stopPrice = entryPrice * (1 - slPct);
      takeProfitPrice = entryPrice * (1 + tpPct);
      await this.exchange.createOrder(SYMBOL, 'STOP_MARKET', 'sell', quantity, null, {
        stopPrice,
        closePosition: true,
        reduceOnly: true,
        timeInForce: 'GTC',
      });
      await this.exchange.createOrder(SYMBOL, 'TAKE_PROFIT_MARKET', 'sell', quantity, null, {
        stopPrice: takeProfitPrice,
        closePosition: true,
        reduceOnly: true,
        timeInForce: 'GTC',
      });
    } else if (positionSide === 'short') {
      stopPrice = entryPrice * (1 + slPct);
      takeProfitPrice = entryPrice * (1 - tpPct);
      await this.exchange.createOrder(SYMBOL, 'STOP_MARKET', 'buy', quantity, null, {
        stopPrice,
        closePosition: true,
        reduceOnly: true,
        timeInForce: 'GTC',
      });
      await this.exchange.createOrder(SYMBOL, 'TAKE_PROFIT_MARKET', 'buy', quantity, null, {
        stopPrice: takeProfitPrice,
        closePosition: true,
        reduceOnly: true,
        timeInForce: 'GTC',
      });
    }
  }

  async run() {
    const eventLog = { event: 'bot_run', time: moment().format(), message: '' };
    try {
      const balance = await this.fetchBalance();
      const usdtFree = balance.free.USDT || 0;
      eventLog.balanceBefore = balance.total;

      if (usdtFree < DCA_USD_AMOUNT) {
        eventLog.message = `Không đủ USDT để mua, còn: ${usdtFree}`;
        logJSON(eventLog);
        return;
      }

      const signal = await this.analyzeSignal();
      eventLog.signal = signal;
      eventLog.message = `Signal hiện tại: ${signal.toUpperCase()}`;
      logJSON(eventLog);

      if (signal === 'hold') {
        logJSON({ ...eventLog, message: 'Không vào lệnh.' });
        return;
      }

      const lastPrice = await this.getLastPrice();
      const quantity = DCA_USD_AMOUNT / lastPrice;

      if (quantity < MIN_BTC_AMOUNT) {
        eventLog.message = `Số lượng BTC quá nhỏ: ${quantity.toFixed(6)}`;
        logJSON(eventLog);
        return;
      }

      const position = await this.fetchPositions();

      if (position && position.side === signal) {
        eventLog.message = `Tăng vị thế ${signal} thêm ${quantity.toFixed(6)} BTC`;
        logJSON(eventLog);

        const order = await this.placeMarketOrder(signal === 'long' ? 'buy' : 'sell', quantity);
        await this.placeStopLossTakeProfit(signal, position.contracts + quantity, position.entryPrice);

        eventLog.orderId = order.id;
        eventLog.message = `Đặt lệnh DCA thành công`;
        const balanceAfter = await this.fetchBalance();
        eventLog.balanceAfter = balanceAfter.total;
        logJSON(eventLog);

      } else if (position && position.side !== signal) {
        eventLog.message = `Đóng vị thế ${position.side} hiện tại: ${position.contracts} contracts`;
        logJSON(eventLog);

        await this.placeMarketOrder(position.side === 'long' ? 'sell' : 'buy', position.contracts);

        eventLog.message = `Mở vị thế mới ${signal} với ${quantity.toFixed(6)} BTC`;
        logJSON(eventLog);

        const order = await this.placeMarketOrder(signal === 'long' ? 'buy' : 'sell', quantity);
        await this.placeStopLossTakeProfit(signal, quantity, lastPrice);

        eventLog.orderId = order.id;
        eventLog.message = `Đặt lệnh mở vị thế thành công`;
        const balanceAfter = await this.fetchBalance();
        eventLog.balanceAfter = balanceAfter.total;
        logJSON(eventLog);

      } else {
        eventLog.message = `Mở vị thế mới ${signal} với ${quantity.toFixed(6)} BTC`;
        logJSON(eventLog);

        const order = await this.placeMarketOrder(signal === 'long' ? 'buy' : 'sell', quantity);
        await this.placeStopLossTakeProfit(signal, quantity, lastPrice);

        eventLog.orderId = order.id;
        eventLog.message = `Đặt lệnh mở vị thế thành công`;
        const balanceAfter = await this.fetchBalance();
        eventLog.balanceAfter = balanceAfter.total;
        logJSON(eventLog);
      }
    } catch (error) {
      logJSON({ event: 'error', time: moment().format(), message: error.message, stack: error.stack });
    }
  }
}

async function main() {
  try {
    const key = await getKeyFromGDrive();
    
    const bot = new BinanceFuturesDCA(key.apiKey, key.secretKey);

    logJSON({ event: 'start', time: moment().format(), message: 'Bot bắt đầu chạy.' });

    setInterval(() => bot.run(), DCA_INTERVAL);
  } catch (e) {
    logJSON({ event: 'init_error', time: moment().format(), message: e.message, stack: e.stack });
  }
}

main();
