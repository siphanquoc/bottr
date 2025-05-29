const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const delay = require('delay');
const dotenv = require('dotenv');
const { SMA, EMA, RSI } = require('technicalindicators');
const { google } = require('googleapis');
dotenv.config();

let credentials = null;
const MIN_BTC_AMOUNT = 0.00001; // Binance minimum BTC trade amount
const DEBUG_MODE = true; // Enable detailed logging for debugging

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
        const prevClose = prices[i-1][4];
        const high = prices[i][2];
        const low = prices[i][3];
        
        const tr1 = high - low;
        const tr2 = Math.abs(high - prevClose);
        const tr3 = Math.abs(low - prevClose);
        
        trueRanges.push(Math.max(tr1, tr2, tr3));
    }
    
    // Simple moving average of true ranges
    const atr = trueRanges.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    return atr;
};

const formatAmount = (amount) => {
    // Format to 5 decimal places and ensure it meets minimum requirement
    return parseFloat(amount.toFixed(5));
};

const executeTrade = async (binance) => {
    const TRADE_PAIR = 'BTC/USDT';
    const TIME_FRAME = '1m';
    const OHLCV_LENGTH = 100;
    const RISK_PERCENT = 1;
    const MAX_POSITION = 0.2;
    
    try {
        const prices = await binance.fetchOHLCV(TRADE_PAIR, TIME_FRAME, undefined, OHLCV_LENGTH);
        if (prices.length < 50) {
            console.error('Insufficient data');
            return null;
        }
        
        const closes = prices.map(p => p[4]);
        const lastPrice = closes[closes.length - 1];
        
        // Calculate indicators
        const sma20 = SMA.calculate({ period: 20, values: closes });
        const ema12 = EMA.calculate({ period: 12, values: closes });
        const ema26 = EMA.calculate({ period: 26, values: closes });
        const rsi14 = RSI.calculate({ period: 14, values: closes });
        
        const currentSMA20 = sma20[sma20.length - 1];
        const currentEMA12 = ema12[ema12.length - 1];
        const currentEMA26 = ema26[ema26.length - 1];
        const currentRSI14 = rsi14[rsi14.length - 1];
        
        const balance = await binance.fetchBalance();
        const btcBal = balance.total.BTC || 0;
        const usdtBal = balance.total.USDT || 0;
        const portfolioValue = (btcBal * lastPrice) + usdtBal;
        
        // Calculate position size using ATR for better volatility measure
        const atr = calculateATR(prices, 14);
        const riskAmount = portfolioValue * (RISK_PERCENT / 100);
        const rawPositionSize = Math.min(
            (riskAmount / (atr || 10)) / lastPrice, // Fallback to $10 volatility if ATR is 0
            (usdtBal * MAX_POSITION) / lastPrice
        );
        
        // Format position size to meet exchange requirements
        const positionSize = formatAmount(rawPositionSize);
        const minTradeValue = lastPrice * MIN_BTC_AMOUNT;
        
        // Trading strategy conditions
        const goldenCross = currentEMA12 > currentEMA26;
        const deathCross = currentEMA12 < currentEMA26;
        const aboveSMA = lastPrice > currentSMA20;
        const rsiOverbought = currentRSI14 > 70;
        const rsiOversold = currentRSI14 < 30;
        
        // Debugging information
        debugLog('--- INDICATOR VALUES ---');
        debugLog(`EMA12: ${currentEMA12}, EMA26: ${currentEMA26}`);
        debugLog(`SMA20: ${currentSMA20}, Price: ${lastPrice}`);
        debugLog(`RSI14: ${currentRSI14}`);
        debugLog(`ATR: ${atr}`);
        debugLog('--- PORTFOLIO ---');
        debugLog(`BTC: ${btcBal}, USDT: ${usdtBal}, Portfolio Value: ${portfolioValue}`);
        debugLog('--- POSITION CALCULATION ---');
        debugLog(`Risk Amount: ${riskAmount}, Position Size: ${positionSize} BTC`);
        debugLog(`Min Trade Value: ${minTradeValue} USDT, Position Value: ${positionSize * lastPrice} USDT`);
        
        // Trade decision logic
        let direction = 'hold';
        let decisionReason = '';
        
        if (positionSize >= MIN_BTC_AMOUNT && 
            goldenCross && 
            aboveSMA && 
            !rsiOverbought && 
            usdtBal >= positionSize * lastPrice) {
            
            direction = 'buy';
            decisionReason = 'Golden cross + Above SMA20 + RSI not overbought';
        } 
        else if (rsiOversold && 
                 usdtBal >= positionSize * lastPrice && 
                 positionSize >= MIN_BTC_AMOUNT) {
            
            direction = 'buy';
            decisionReason = 'RSI oversold condition';
        }
        else if ((deathCross || rsiOverbought) && btcBal > 0) {
            // For sell orders, use the smaller of positionSize or available BTC
            const sellSize = formatAmount(Math.min(btcBal, positionSize));
            if (sellSize >= MIN_BTC_AMOUNT) {
                direction = 'sell';
                decisionReason = deathCross ? 'Death cross' : 'RSI overbought';
            } else {
                decisionReason = `Sell size too small: ${sellSize} < ${MIN_BTC_AMOUNT}`;
            }
        } else {
            decisionReason = 'No trade conditions met';
        }
        
        debugLog('--- TRADE DECISION ---');
        debugLog(`Direction: ${direction}, Reason: ${decisionReason}`);
        
        let executedSize = 0;
        if (direction !== 'hold') {
            const orderSize = direction === 'buy' 
                ? positionSize 
                : formatAmount(Math.min(btcBal, positionSize));
                
            if (orderSize >= MIN_BTC_AMOUNT) {
                debugLog(`Creating ${direction} order for ${orderSize} BTC`);
                await binance.createMarketOrder(TRADE_PAIR, direction, orderSize);
                executedSize = orderSize;
            } else {
                debugLog(`Skipped trade: Order size ${orderSize} BTC is below minimum ${MIN_BTC_AMOUNT} BTC`);
                direction = 'hold'; // Reset direction
            }
        }
        
        const tradeInfo = {
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
            direction,
            size: executedSize,
            price: lastPrice,
            indicators: {
                sma20: currentSMA20,
                ema12: currentEMA12,
                ema26: currentEMA26,
                rsi14: currentRSI14,
                atr
            },
            portfolio: {
                BTC: btcBal,
                USDT: usdtBal,
                totalValue: portfolioValue
            },
            decisionReason,
            conditions: {
                goldenCross,
                deathCross,
                aboveSMA,
                rsiOverbought,
                rsiOversold
            }
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
        
        // Using stream response as requested
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
        
        // Load markets to get precision info
        await binance.loadMarkets();
        const market = binance.market('BTC/USDT');
        debugLog('Market precision:', market.precision);
        
        while (true) {
            try {
                console.log(`\n[${moment().format('HH:mm:ss')}] Starting trading cycle...`);
                const tradeResult = await executeTrade(binance);
                if (tradeResult && tradeResult.direction !== 'hold') {
                    console.log(`Executed ${tradeResult.direction} order for ${tradeResult.size} BTC at ${tradeResult.price} USDT`);
                } else {
                    console.log('No trade executed');
                }
            } catch (error) {
                console.error('Cycle error:', error);
            }
            await delay(60000); // 1 minute delay
        }
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
};

main();