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

const calculateVolatility = (prices) => {
    if (prices.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i < prices.length; i++) {
        sum += (prices[i][2] - prices[i][3]); // High - Low
    }
    return sum / prices.length;
};

const formatAmount = (amount) => {
    // Format to 5 decimal places and ensure it meets minimum requirement
    const formatted = parseFloat(amount.toFixed(5));
    return formatted >= MIN_BTC_AMOUNT ? formatted : 0;
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
        
        const riskAmount = portfolioValue * (RISK_PERCENT / 100);
        const volatility = calculateVolatility(prices.slice(-20));
        const rawPositionSize = Math.min(
            (riskAmount / Math.max(volatility, 0.001)) / lastPrice,
            (usdtBal * MAX_POSITION) / lastPrice
        );
        
        // Format position size to meet exchange requirements
        const positionSize = formatAmount(rawPositionSize);
        
        // Trading strategy
        const goldenCross = currentEMA12 > currentEMA26;
        const deathCross = currentEMA12 < currentEMA26;
        const aboveSMA = lastPrice > currentSMA20;
        const rsiOverbought = currentRSI14 > 70;
        
        let direction = 'hold';
        if (positionSize > 0 && goldenCross && aboveSMA && !rsiOverbought && usdtBal >= positionSize * lastPrice) {
            direction = 'buy';
        } else if ((deathCross || rsiOverbought) && btcBal > 0) {
            // For sell orders, use the smaller of positionSize or available BTC
            const sellSize = formatAmount(Math.min(btcBal, positionSize));
            if (sellSize > 0) {
                direction = 'sell';
            }
        }
        
        let executedSize = 0;
        if (direction !== 'hold') {
            const orderSize = direction === 'buy' 
                ? positionSize 
                : formatAmount(Math.min(btcBal, positionSize));
                
            if (orderSize >= MIN_BTC_AMOUNT) {
                await binance.createMarketOrder(TRADE_PAIR, direction, orderSize);
                executedSize = orderSize;
            } else {
                console.log(`Skipped trade: Order size ${orderSize} BTC is below minimum ${MIN_BTC_AMOUNT} BTC`);
                direction = 'hold'; // Reset direction if amount too small
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
            },
            portfolio: {
                BTC: btcBal,
                USDT: usdtBal,
                totalValue: portfolioValue
            }
        };
        
        await logTrade(tradeInfo);
        return tradeInfo;
        
    } catch (error) {
        console.error('Trading error:', error);
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
            options: { recvWindow: 60000 }
        });
        
        binance.setSandboxMode(true);
        
        while (true) {
            try {
                console.log(`[${moment().format('HH:mm:ss')}] Running trading cycle...`);
                await executeTrade(binance);
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