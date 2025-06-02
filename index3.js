const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const dotenv = require('dotenv');
const { google } = require('googleapis');

dotenv.config();

const SYMBOL = 'DOGE/USDT';
const DCA_USD_AMOUNT = 10;
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
        },
      },
    });
    this.exchange.setSandboxMode(true); // bật testnet
  }

  // Hàm đặt đòn bẩy (leverage) cho symbol
  async setLeverage(leverage = 5) {
    try {
      await this.exchange.setLeverage(leverage, SYMBOL);
      logJSON({ event: 'leverage_set', time: moment().format(), message: `Đã đặt đòn bẩy x${leverage} cho ${SYMBOL}` });
    } catch (error) {
      logJSON({ event: 'error_leverage', time: moment().format(), message: `Lỗi đặt đòn bẩy: ${error.message}` });
    }
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

  calculateATR(ohlcv, period = 14) {
    const trs = [];
    for (let i = 1; i < ohlcv.length; i++) {
      const high = ohlcv[i][2];
      const low = ohlcv[i][3];
      const prevClose = ohlcv[i - 1][4];
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    const atrs = [];
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    atrs.push(atr);
    for (let i = period; i < trs.length; i++) {
      atr = (atrs[atrs.length - 1] * (period - 1) + trs[i]) / period;
      atrs.push(atr);
    }
    return atrs;
  }

  async fetchOHLCV(limit = 50) {
    return await this.exchange.fetchOHLCV(SYMBOL, '1m', undefined, limit);
  }

  async analyzeSignal() {
    const ohlcv = await this.fetchOHLCV(100); // lấy thêm dữ liệu để làm mượt
    const closes = ohlcv.map(c => c[4]);

    const emaShort = this.calculateEMA(closes, 9);
    const emaLong = this.calculateEMA(closes, 21);
    const rsi = this.calculateRSI(closes, 14);
    const atr = this.calculateATR(ohlcv, 14); // đo biến động
    const recentVolatility = atr[atr.length - 1];

    const prevEmaShort = emaShort[emaShort.length - 2];
    const prevEmaLong = emaLong[emaLong.length - 2];
    const currEmaShort = emaShort[emaShort.length - 1];
    const currEmaLong = emaLong[emaLong.length - 1];

    // Lọc tín hiệu giả khi biến động quá thấp (đi ngang)
    if (recentVolatility < 0.0005) return 'hold'; // tuỳ DOGE khung 1m hoặc 5m

    const isGoldenCross = prevEmaShort < prevEmaLong && currEmaShort > currEmaLong;
    const isDeathCross = prevEmaShort > prevEmaLong && currEmaShort < currEmaLong;

    if (isGoldenCross && rsi > 45 && rsi < 70) return 'long';
    if (isDeathCross && rsi < 55 && rsi > 30) return 'short';

    return 'hold';
  }

  async placeMarketOrder(side, amount) {
    if (side === 'buy') return await this.exchange.createMarketBuyOrder(SYMBOL, amount);
    else if (side === 'sell') return await this.exchange.createMarketSellOrder(SYMBOL, amount);
  }

  async placeStopLossTakeProfit(positionSide, quantity, entryPrice) {
    const slPct = 0.01; // Stop-loss 1%
    const tpPct = 0.02; // Take-profit 2%

    let stopPrice, takeProfitPrice;

    if (positionSide === 'long') {
      stopPrice = entryPrice * (1 - slPct);
      takeProfitPrice = entryPrice * (1 + tpPct);

      // Đặt lệnh stop-loss
      await this.exchange.createOrder(SYMBOL, 'STOP_MARKET', 'sell', quantity, null, {
        stopPrice: parseFloat(stopPrice.toFixed(6)), // làm tròn số
        timeInForce: 'GTC',
      });

      // Đặt lệnh take-profit
      await this.exchange.createOrder(SYMBOL, 'TAKE_PROFIT_MARKET', 'sell', quantity, null, {
        stopPrice: parseFloat(takeProfitPrice.toFixed(6)),
        timeInForce: 'GTC',
      });
    } else if (positionSide === 'short') {
      stopPrice = entryPrice * (1 + slPct);
      takeProfitPrice = entryPrice * (1 - tpPct);

      await this.exchange.createOrder(SYMBOL, 'STOP_MARKET', 'buy', quantity, null, {
        stopPrice: parseFloat(stopPrice.toFixed(6)),
        timeInForce: 'GTC',
      });

      await this.exchange.createOrder(SYMBOL, 'TAKE_PROFIT_MARKET', 'buy', quantity, null, {
        stopPrice: parseFloat(takeProfitPrice.toFixed(6)),
        timeInForce: 'GTC',
      });
    }
  }

  async run() {
    const eventLog = { event: 'bot_run', time: moment().format(), message: '' };
    try {
      const signal = await this.analyzeSignal();
      eventLog.message = `Signal hiện tại: ${signal}`;
      logJSON(eventLog);
  
      // Chỉ xử lý nếu có tín hiệu long hoặc short
      if (signal === 'long' || signal === 'short') {
        // Đặt đòn bẩy
        await this.setLeverage(5);
  
        const balance = await this.fetchBalance();
        const usdtFree = balance.free.USDT || 0;
        eventLog.balanceBefore = { USDT: usdtFree };
  
        if (usdtFree < DCA_USD_AMOUNT) {
          eventLog.message = `Không đủ USDT để mua, còn: ${usdtFree}`;
          logJSON(eventLog);
          return;
        }
  
        const lastPrice = await this.getLastPrice();
        const quantity = (DCA_USD_AMOUNT / lastPrice).toFixed(3);
  
        if (quantity < MIN_BTC_AMOUNT) {
          eventLog.message = `Số lượng mua (${quantity}) nhỏ hơn tối thiểu (${MIN_BTC_AMOUNT})`;
          logJSON(eventLog);
          return;
        }
  
        if (signal === 'long') {
          const order = await this.placeMarketOrder('buy', quantity);
          eventLog.message = `Đặt lệnh mua ${quantity} ${SYMBOL} thành công`;
          logJSON(eventLog);
  
          await this.placeStopLossTakeProfit('long', quantity, lastPrice);
          eventLog.message = 'Đã đặt SL và TP cho lệnh long';
          logJSON(eventLog);
        } else if (signal === 'short') {
          const order = await this.placeMarketOrder('sell', quantity);
          eventLog.message = `Đặt lệnh bán khống ${quantity} ${SYMBOL} thành công`;
          logJSON(eventLog);
  
          await this.placeStopLossTakeProfit('short', quantity, lastPrice);
          eventLog.message = 'Đã đặt SL và TP cho lệnh short';
          logJSON(eventLog);
        }
      } else {
        // Nếu là "hold", không cần làm gì thêm
        eventLog.message = 'Không có tín hiệu mua/bán. Giữ trạng thái hiện tại.';
        logJSON(eventLog);
      }
    } catch (error) {
      logJSON({ event: 'error', time: moment().format(), message: error.message });
    }
  }  
}

(async () => {
  try {
    const { apiKey, secretKey } = await getKeyFromGDrive();
    const bot = new BinanceFuturesDCA(apiKey, secretKey);

    // Chạy bot theo khoảng thời gian định sẵn
    setInterval(() => bot.run(), DCA_INTERVAL);
    console.log('Bot DCA Futures đã khởi động...');
  } catch (err) {
    console.error('Lỗi lấy API key:', err);
  }
})();
