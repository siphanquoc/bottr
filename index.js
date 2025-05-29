const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const delay = require('delay');
const dotenv = require('dotenv');
const { SMA, EMA, RSI, MACD, Stochastic } = require('technicalindicators');
const { google } = require('googleapis');
dotenv.config();

let credentials = null;
const MIN_BTC_AMOUNT = 0.00001;
const DEBUG_MODE = true;
const AGGRESSIVE_MODE = true;
const MAX_RISK_PERCENT = 3;
const MAX_POSITION_SIZE = 0.3;
const VOLATILITY_THRESHOLD = 0.015;
const TRADE_COOLDOWN = 15000;

// Trade state tracking
let tradeState = {
    lastTrade: null,
    positionSize: 0,
    entryPrice: 0,
    dailyProfit: 0,
    tradesToday: 0,
    consecutiveLosses: 0,
};

const logTrade = async (tradeInfo) => {
    try {
        const logFolder = path.join('./', 'log');
        if (!fs.existsSync(logFolder)) fs.mkdirSync(logFolder);
        
        const logFilePath = path.join(logFolder, `trades_${moment().format('YYYY-MM-DD')}.json`);
        let logData = [];
        
        if (fs.existsSync(logFilePath)) {
            logData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
        }
        
        logData.unshift(tradeInfo);
        fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2));
        
        console.log(`Trade logged to ${logFilePath}`);
    } catch (error) {
        console.error('Logging error:', error);
    }
};

const debugLog = (...messages) => {
    if (DEBUG_MODE) {
        console.log('[DEBUG]', ...messages);
    }
};

const calculateATR = (prices, period = 14) => {
    if (prices.length < period + 1) return 0;
    
    const trueRanges = [];
    for (let i = 1; i < prices.length; i++) {
        const prevClose = prices[i - 1][4];
        const high = prices[i][2];
        const low = prices[i][3];
        
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        
        trueRanges.push(Math.max(tr1, tr2, tr3));
    }
    
    const atr = trueRanges.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    return atr;
};

const formatAmount = (amount) => {
    return parseFloat(amount.toFixed(5));
};

const calculateEnhancedIndicators = (prices) => {
    const closes = prices.map(p => p[4]);
    const highs = prices.map(p => p[2]);
    const lows = prices.map(p => p[3]);
    
    const sma20 = SMA.calculate({ period: 20, values: closes });
    const ema12 = EMA.calculate({ period: 12, values: closes });
    const ema26 = EMA.calculate({ period: 26, values: closes });
    const rsi14 = RSI.calculate({ period: 14, values: closes });
    
    const macd = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
    });
    
    const stoch = Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
        signalPeriod: 3
    });
    
    const atr = calculateATR(prices, 14);
    const volatilityRatio = atr / closes[closes.length - 1];
    
    const current = {
        price: closes[closes.length - 1],
        sma20: sma20[sma20.length - 1],
        ema12: ema12[ema12.length - 1],
        ema26: ema26[ema26.length - 1],
        rsi14: rsi14[rsi14.length - 1],
        macd: macd[macd.length - 1],
        stoch: stoch[stoch.length - 1],
        atr,
        volatilityRatio
    };
    
    const previous = {
        ema12: ema12[ema12.length - 2],
        ema26: ema26[ema26.length - 2],
        macd: macd[macd.length - 2],
        stoch: stoch[stoch.length - 2],
    };
    
    return { current, previous };
};

const executeTrade = async (binance) => {
    const TRADE_PAIR = 'BTC/USDT';
    const TIME_FRAME = '1m';
    const OHLCV_LENGTH = 100;
    
    try {
        // Trade cooldown protection
        if (tradeState.lastTrade && Date.now() - tradeState.lastTrade < TRADE_COOLDOWN) {
            await delay(TRADE_COOLDOWN - (Date.now() - tradeState.lastTrade));
        }

        const prices = await binance.fetchOHLCV(TRADE_PAIR, TIME_FRAME, undefined, OHLCV_LENGTH);
        if (prices.length < 50) {
            console.error('Insufficient data');
            return null;
        }

        const { current, previous } = calculateEnhancedIndicators(prices);
        const lastPrice = current.price;

        const balance = await binance.fetchBalance();
        const btcBal = balance.total.BTC || 0;
        const usdtBal = balance.total.USDT || 0;
        const portfolioValue = (btcBal * lastPrice) + usdtBal;

        // Debug logging for indicator values
        debugLog('--- INDICATOR VALUES ---');
        debugLog(`EMA12: ${current.ema12}, EMA26: ${current.ema26}`);
        debugLog(`SMA20: ${current.sma20}, Price: ${lastPrice}`);
        debugLog(`RSI14: ${current.rsi14}`);
        debugLog(`ATR: ${current.atr}`);

        // Debug logging for portfolio
        debugLog('--- PORTFOLIO ---');
        debugLog(`BTC: ${btcBal}, USDT: ${usdtBal}, Portfolio Value: ${portfolioValue}`);

        // Dynamic position sizing
        const riskAmount = portfolioValue * (MAX_RISK_PERCENT / 100);
        const rawPositionSize = Math.min(
            (riskAmount / (current.atr || 10)) / lastPrice,
            (usdtBal * MAX_POSITION_SIZE) / lastPrice
        );

        const positionSize = formatAmount(rawPositionSize);
        const minTradeValue = lastPrice * MIN_BTC_AMOUNT;

        // Debug logging for position calculation
        debugLog('--- POSITION CALCULATION ---');
        debugLog(`Risk Amount: ${riskAmount}, Position Size: ${positionSize} BTC`);
        debugLog(`Min Trade Value: ${minTradeValue} USDT, Position Value: ${usdtBal * positionSize}`);

        // Trade decision logic...
        let direction = 'hold';
        let decisionReason = 'No trade conditions met';

        // Enhanced trading conditions
        const goldenCross = current.ema12 > current.ema26 && previous.ema12 <= previous.ema26;
        const deathCross = current.ema12 < current.ema26 && previous.ema12 >= previous.ema26;
        const macdBullish = current.macd.MACD > current.macd.signal;
        const macdBearish = current.macd.MACD < current.macd.signal;
        const stochBullish = current.stoch.k > 20 && current.stoch.k > current.stoch.d;
        const stochBearish = current.stoch.k < 80 && current.stoch.k < current.stoch.d;
        const aboveSMA = lastPrice > current.sma20;
        const rsiOverbought = current.rsi14 > 70;
        const rsiOversold = current.rsi14 < 30;
        const highVolatility = current.volatilityRatio > VOLATILITY_THRESHOLD;
        
        if (AGGRESSIVE_MODE) {
            if (positionSize >= MIN_BTC_AMOUNT && usdtBal >= positionSize * lastPrice) {
                // Momentum breakout
                if (goldenCross && macdBullish && stochBullish && aboveSMA && highVolatility) {
                    direction = 'buy';
                    decisionReason = 'Momentum breakout';
                } 
                // Reversal pattern
                else if (rsiOversold && current.rsi14 > previous.rsi14 && !deathCross) {
                    direction = 'buy';
                    decisionReason = 'RSI reversal';
                }
            }
            
            // Aggressive exit conditions
            if (btcBal > 0) {
                const sellSize = formatAmount(Math.min(btcBal, positionSize));
                if (sellSize >= MIN_BTC_AMOUNT) {
                    // Take profit strategy
                    const profitPercent = tradeState.entryPrice > 0 ? 
                        ((lastPrice - tradeState.entryPrice) / tradeState.entryPrice) * 100 : 0;
                    
                    if (profitPercent > 1.5) {
                        direction = 'sell';
                        decisionReason = `Take profit (${profitPercent.toFixed(2)}%)`;
                    }
                    // Stop loss strategy
                    else if (profitPercent < -1) {
                        direction = 'sell';
                        decisionReason = `Stop loss (${profitPercent.toFixed(2)}%)`;
                    }
                    // Technical exit signals
                    else if (deathCross || rsiOverbought || macdBearish) {
                        direction = 'sell';
                        decisionReason = 'Technical exit';
                    }
                }
            }
        }

        // Execute trade
        let executedSize = 0;
        if (direction !== 'hold') {
            const orderSize = direction === 'buy' 
                ? positionSize 
                : formatAmount(Math.min(btcBal, positionSize));
                
            if (orderSize >= MIN_BTC_AMOUNT) {
                debugLog(`Creating ${direction} order for ${orderSize} BTC`);
                await binance.createMarketOrder(TRADE_PAIR, direction, orderSize);
                executedSize = orderSize;
                
                // Update trade state
                tradeState.lastTrade = Date.now();
                tradeState.tradesToday++;
                
                if (direction === 'buy') {
                    tradeState.positionSize = orderSize;
                    tradeState.entryPrice = lastPrice;
                    tradeState.consecutiveLosses = 0;
                } else {
                    const profitPercent = tradeState.entryPrice > 0 ? 
                        ((lastPrice - tradeState.entryPrice) / tradeState.entryPrice) * 100 : 0;
                    
                    tradeState.dailyProfit += profitPercent;
                    tradeState.positionSize = 0;
                    
                    // Update win/loss tracking
                    if (profitPercent <= 0) {
                        tradeState.consecutiveLosses++;
                    } else {
                        tradeState.consecutiveLosses = 0;
                    }
                }
            }
        }
        
        // Enhanced trade logging
        const tradeInfo = {
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
            direction,
            size: executedSize,
            price: lastPrice,
            indicators: current,
            portfolio: {
                BTC: btcBal,
                USDT: usdtBal,
                totalValue: portfolioValue
            },
            decisionReason,
            dailyProfit: tradeState.dailyProfit,
            tradesToday: tradeState.tradesToday,
            consecutiveLosses: tradeState.consecutiveLosses,
            riskPercent: MAX_RISK_PERCENT
        };
        
        await logTrade(tradeInfo);
        return tradeInfo;
        
    } catch (error) {
        console.error('Trading error:', error);
        debugLog('Error details:', error);
        return null;
    }
};

const getKeysFromGoogleDrive = async () => {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: path.join('./', 'credentials.json'),
            scopes: [process.env.GOOGLE_AUTH_SCOPES]
        });
        
        const drive = google.drive({ version: 'v3', auth });
        
        const response = await drive.files.get(
            { fileId: process.env.GOOGLE_FIELD_ID, alt: 'media' },
            { responseType: 'stream' }
        );
        
        return new Promise((resolve, reject) => {
            let data = '';
            
            response.data
                .on('data', (chunk) => {
                    data += chunk;
                })
                .on('end', () => {
                    try {
                        credentials = JSON.parse(data);
                        resolve(true);
                    } catch (parseError) {
                        reject(parseError);
                    }
                })
                .on('error', reject);
        });
        
    } catch (error) {
        console.error('Google Drive error:', error);
        throw error;
    }
};

const main = async () => {
    try {
        await getKeysFromGoogleDrive();
        if (!credentials) throw new Error('Credentials not found');
        
        const binance = new ccxt.binance({
            apiKey: credentials.apiKey,
            secret: credentials.secretKey,
            options: { 
                recvWindow: 60000,
                adjustForTimeDifference: true
            }
        });
        
        binance.setSandboxMode(true);
        await binance.loadMarkets();
        
        while (true) {
            try {
                console.log(`\n[${moment().format('HH:mm:ss')}] Starting trading cycle...`);
                const tradeResult = await executeTrade(binance);
                
                if (tradeResult) {
                    if (tradeResult.direction !== 'hold') {
                        console.log(`Executed ${tradeResult.direction} order: ${tradeResult.size} BTC at ${tradeResult.price}`);
                        console.log(`Reason: ${tradeResult.decisionReason}`);
                    }
                    console.log(`Daily profit: ${tradeResult.dailyProfit.toFixed(2)}%`);
                }
                
                const prices = await binance.fetchOHLCV('BTC/USDT', '1m', undefined, 20);
                const atr = calculateATR(prices, 14);
                const lastPrice = prices[prices.length - 1][4];
                const volatility = atr / lastPrice;
                
                const delayTime = volatility > 0.02 ? 30000 : 60000;
                await delay(delayTime);
                
            } catch (error) {
                console.error('Cycle error:', error);
                await delay(30000); // Wait 30 seconds after errors
            }
        }
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
};

main();