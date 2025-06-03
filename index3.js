// Binance Futures DCA Bot with Sync + Smart TP/SL
const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const dotenv = require('dotenv');
const { google } = require('googleapis');

dotenv.config();

// === Cấu hình các tham số giao dịch chính ===
const SYMBOLS = ['BTC/USDT'];
const DCA_USD_AMOUNT = 110;
const MIN_CRYPTO_AMOUNT = 0.001;
const DCA_INTERVAL = 60 * 1000; // Chạy mỗi phút
const SYNC_ORDER_INTERVAL = 5 * 60 * 1000; // Đồng bộ lệnh mỗi 5 phút
const LEVERAGE = 5;

// === Cấu hình đường dẫn lưu log và trạng thái lệnh ===
const LOG_DIR = path.join(__dirname, 'logFU');
const ORDER_PATH = path.join(__dirname, 'order', 'order.json');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
if (!fs.existsSync(path.dirname(ORDER_PATH))) fs.mkdirSync(path.dirname(ORDER_PATH));

// === Ghi log JSON có thời gian ===
function logJSON(data) {
  const filename = path.join(LOG_DIR, `log_${moment().format('YYYY-MM-DD')}.json`);
  let logs = [];
  if (fs.existsSync(filename)) {
    try { logs = JSON.parse(fs.readFileSync(filename)); } catch { logs = []; }
  }
  logs.unshift(data);
  fs.writeFileSync(filename, JSON.stringify(logs, null, 2));
  console.log(`${moment().format('YYYY-MM-DD HH:mm:ss')} | ${data.event} | ${data.message}`);
}

// === Lưu và tải trạng thái lệnh ===
function saveOrderState(orderState) {
  fs.writeFileSync(ORDER_PATH, JSON.stringify(orderState, null, 2));
}
function loadOrderState() {
  if (!fs.existsSync(ORDER_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(ORDER_PATH)); } catch { return {}; }
}

// === Lấy API key từ Google Drive ===
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
    res.data.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    res.data.on('error', reject);
  });
}

class BinanceFuturesDCA {
  constructor(apiKey, secret) {
    this.exchange = new ccxt.binanceusdm({
      apiKey, secret, enableRateLimit: true,
      options: { defaultType: 'future', adjustForTimeDifference: true },
    });
    this.exchange.setSandboxMode(true);
    const state = loadOrderState();
    this.orderState = typeof state === 'object' && state !== null ? state : {};
  }

  // === Đặt đòn bẩy cho mỗi cặp ===
  async setLeverage(symbol, leverage = LEVERAGE) {
    try {
      await this.exchange.setLeverage(leverage, symbol);
      logJSON({ event: 'leverage_set', time: moment().format(), message: `Đòn bẩy x${leverage} đặt cho ${symbol}` });
    } catch (error) {
      logJSON({ event: 'error_leverage', time: moment().format(), message: error.message });
    }
  }

  async fetchBalance() {
    return await this.exchange.fetchBalance();
  }

  async fetchPositions(symbol) {
    try {
      const positions = await this.exchange.fetchPositions([symbol]);
      return positions.find(p => p.symbol === symbol && Math.abs(p.contracts || 0) > 0) || null;
    } catch (e) {
      logJSON({ event: 'error_fetch_positions', time: moment().format(), symbol, message: e.message });
      return null;
    }
  }

  async fetchOpenOrders(symbol) {
    try {
      return await this.exchange.fetchOpenOrders(symbol);
    } catch (e) {
      logJSON({ event: 'error_fetch_open_orders', time: moment().format(), symbol, message: e.message });
      return [];
    }
  }

  // === Đồng bộ lệnh mở từ sàn về file order.json ===
  async syncOpenOrders() {
    if (typeof this.orderState !== 'object') this.orderState = {};
    for (const symbol of SYMBOLS) {
      const openOrders = await this.fetchOpenOrders(symbol);
      this.orderState[symbol] = this.orderState[symbol] || {};
      this.orderState[symbol].pendingOrders = openOrders.map(o => ({
        id: o.id, type: o.type, side: o.side, price: o.price,
        amount: o.amount, status: o.status,
      }));
  
      // ➕ Đồng bộ vị thế đang mở
      const position = await this.fetchPositions(symbol);
      if (position) {
        const lastPrice = (await this.exchange.fetchTicker(symbol)).last;
        const pnlData = this.calculatePnL(position, lastPrice);
        this.orderState[symbol] = {
          ...this.orderState[symbol],
          time: moment().format(),
          signal: position.side.toLowerCase(),
          entry: position.entryPrice,
          size: position.contracts,
          side: position.side,
          lastPrice,
          pnl: pnlData.pnl,
          pnlPct: pnlData.pct,
          pendingOrders: this.orderState[symbol].pendingOrders || []
        };
      }
    }
    saveOrderState(this.orderState);
  }
  

  // === Tính toán lời/lỗ hiện tại của vị thế ===
  calculatePnL(position, lastPrice) {
    const { entryPrice: entry, contracts: size, side } = position;
    const long = side.toLowerCase() === 'long';
    const pnl = long ? (lastPrice - entry) * size : (entry - lastPrice) * size;
    const pct = (pnl / (entry * size)) * 100;
    return { pnl: +pnl.toFixed(2), pct: +pct.toFixed(2) };
  }

  // === Kiểm tra và đóng lệnh nếu đạt TP/SL sớm ===
  async checkAndClosePositions() {
    for (const symbol of SYMBOLS) {
      const position = await this.fetchPositions(symbol);
      if (!position) continue;
      const lastPrice = (await this.exchange.fetchTicker(symbol)).last;
      const { pnl, pct } = this.calculatePnL(position, lastPrice);
      if (pct >= 2 || pct <= -5) {
        const closeSide = position.side.toLowerCase() === 'long' ? 'sell' : 'buy';
        try {
          await this.exchange.createMarketOrder(symbol, closeSide, position.contracts);
          logJSON({ event: 'manual_close', time: moment().format(), symbol, message: `Đóng vị thế ${symbol} với PnL ${pct.toFixed(2)}%` });
          delete this.orderState[symbol];
          saveOrderState(this.orderState);
        } catch (e) {
          logJSON({ event: 'error_close_position', time: moment().format(), symbol, message: e.message });
        }
      }
    }
  }

  // === Tính toán EMA và RSI đơn giản ===
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

  // === Phân tích tín hiệu mua/bán từ EMA và RSI ===
  async analyzeSignal(symbol) {
    const ohlcv = await this.exchange.fetchOHLCV(symbol, '1m', undefined, 100);
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

  // === Đặt lệnh thị trường, TP và SL thông minh ===
  async placeOrders(symbol, signal, qty, price) {
    const side = signal === 'long' ? 'buy' : 'sell';
    const sl = signal === 'long' ? price * 0.99 : price * 1.01;
    const tp = signal === 'long' ? price * 1.02 : price * 0.98;

    await this.exchange.createMarketOrder(symbol, side, qty);
    await this.exchange.createOrder(symbol, 'STOP_MARKET', side === 'buy' ? 'sell' : 'buy', qty, null, {
      stopPrice: +sl.toFixed(6),
      timeInForce: 'GTC',
    });
    await this.exchange.createOrder(symbol, 'TAKE_PROFIT_MARKET', side === 'buy' ? 'sell' : 'buy', qty, null, {
      stopPrice: +tp.toFixed(6),
      timeInForce: 'GTC',
    });
  }

  // === Logic xử lý mỗi cặp giao dịch ===
  async runForSymbol(symbol) {
    const now = moment().format();

    const position = await this.fetchPositions(symbol);
    if (position) {
      logJSON({ event: 'skip_active_position', time: now, symbol, message: 'Đang có vị thế mở, bỏ qua.' });
      return;
    }

    const pending = this.orderState[symbol]?.pendingOrders || [];
    if (pending.length > 0) {
      logJSON({ event: 'skip_pending_order', time: now, symbol, message: `Đã có ${pending.length} lệnh đang mở.` });
      return;
    }

    const signal = await this.analyzeSignal(symbol);
    logJSON({ event: 'signal', time: now, symbol, message: `Tín hiệu: ${signal}` });
    if (signal === 'hold') return;

    await this.setLeverage(symbol);
    const balance = await this.fetchBalance();
    const lastPrice = (await this.exchange.fetchTicker(symbol)).last;
    const qty = +(DCA_USD_AMOUNT / lastPrice).toFixed(3);
    if (qty < MIN_CRYPTO_AMOUNT || (balance.free.USDT || 0) < DCA_USD_AMOUNT) {
      logJSON({ event: 'insufficient', time: now, symbol, message: 'Không đủ điều kiện đặt lệnh.' });
      return;
    }

    await this.placeOrders(symbol, signal, qty, lastPrice);
    const newPosition = await this.fetchPositions(symbol);
    if (!newPosition) return;
    const pnlData = this.calculatePnL(newPosition, lastPrice);
    this.orderState[symbol] = {
      ...this.orderState[symbol],
      time: now,
      signal,
      entry: newPosition.entryPrice,
      size: newPosition.contracts,
      side: newPosition.side,
      lastPrice,
      pnl: pnlData.pnl,
      pnlPct: pnlData.pct,
    };
    saveOrderState(this.orderState);
    logJSON({ event: 'order_done', time: now, symbol, message: `Đã đặt ${signal} ${qty} ${symbol}` });
  }

  async runAll() {
    await this.checkAndClosePositions();
    for (const symbol of SYMBOLS) {
      try { await this.runForSymbol(symbol); } catch (e) {
        logJSON({ event: 'error_run_symbol', time: moment().format(), symbol, message: e.message });
      }
    }
  }
}

// === Khởi động bot ===
(async () => {
  const { apiKey, secretKey } = await getKeyFromGDrive();
  const bot = new BinanceFuturesDCA(apiKey, secretKey);

  await bot.syncOpenOrders(); // Lấy lệnh mở ban đầu từ sàn
  setInterval(() => bot.syncOpenOrders(), SYNC_ORDER_INTERVAL);
  setInterval(() => bot.runAll(), DCA_INTERVAL);
  console.log('Bot Binance Futures DCA đang chạy với nhiều cặp...');
})();