const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const delay = require('delay');
const dotenv = require('dotenv');
const { google } = require('googleapis');
const math = require('mathjs');

dotenv.config();

var fileContent = undefined;

const printBalance = async (infoPrice) => {
    try {
        const logFolder = path.join('./', 'log');
        if (!fs.existsSync(logFolder)) {
            fs.mkdirSync(logFolder);
        }
        const logFilePath = path.join(logFolder, `log_${moment().format('YYYY-MM-DD')}.json`);
        if (fs.existsSync(logFilePath)) {
            const existingData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
            existingData.unshift(infoPrice);
            fs.writeFileSync(logFilePath, JSON.stringify(existingData, null, 2), 'utf8');
        } else {
            fs.writeFileSync(logFilePath, JSON.stringify([infoPrice], null, 2), 'utf8');
        }
        console.log(`Balance logged to ${logFilePath}`);
    } catch (error) {
        console.error('Error loading balance:', error);
    }
};

// Gaussian kernel function
function gaussianKernel(x, xi, h) {
    return Math.exp(-Math.pow(x - xi, 2) / (2 * Math.pow(h, 2)));
}

// Nadaraya-Watson estimator
function nadarayaWatson(x, X, Y, h) {
    const weights = X.map(xi => gaussianKernel(x, xi, h));
    const numerator = weights.reduce((sum, w, i) => sum + w * Y[i], 0);
    const denominator = weights.reduce((sum, w) => sum + w, 0);
    return numerator / denominator;
}

// Generate upper/lower envelopes
function getEnvelopes(X, Y, h, bandWidth = 0.01) {
    const smooth = X.map(x => nadarayaWatson(x, X, Y, h));
    const upper = smooth.map(s => s * (1 + bandWidth));
    const lower = smooth.map(s => s * (1 - bandWidth));
    return { smooth, upper, lower };
}

const order = async (binance) => {
    try {
        const size = 20; // Trade size in USDT
        const prices = await binance.fetchOHLCV('BTC/USDT', '1m', undefined, 50);
        const closes = prices.map(p => p[4]);
        const timestamps = prices.map(p => p[0]);

        const h = 5; // Kernel smoothing bandwidth
        const { upper, lower } = getEnvelopes(timestamps, closes, h);

        const lastPrice = closes[closes.length - 1];
        const lastUpper = upper[upper.length - 1];
        const lastLower = lower[lower.length - 1];

        const balance = await binance.fetchBalance();
        let quantity = size / lastPrice;
        let direction = 'hold';

        if (lastPrice > lastUpper && balance.total.BTC > 0) {
            quantity = Math.min(quantity, balance.total.BTC);
            direction = 'sell';
        } else if (lastPrice < lastLower && balance.total.USDT >= size) {
            direction = 'buy';
        }

        const infoPrice = {
            lastPrice,
            upperBand: lastUpper,
            lowerBand: lastLower,
            direction,
            timestamp: moment().format('YYYY-MM-DD HH:mm:ss'),
            quantity
        };

        if (direction !== 'hold') {
            const orderResponse = await binance.createMarketOrder('BTC/USDT', direction, quantity);
            console.log(`Order executed: ${direction} ${quantity} BTC at ${lastPrice}`);
            infoPrice.orderId = orderResponse.id;
        }

        const balanceAfterOrder = await binance.fetchBalance();
        infoPrice.balance = {
            BTC: balanceAfterOrder.total.BTC,
            USDT: balanceAfterOrder.total.USDT,
            totalUSDT: balanceAfterOrder.total.BTC * lastPrice + balanceAfterOrder.total.USDT
        };

        await printBalance(infoPrice);
    } catch (error) {
        console.error('Error placing order:', error);
    }
};

const getKeyfromGDrive = async () => {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: path.join('./', 'credentials.json'),
            scopes: [process.env.GOOGLE_AUTH_SCOPES]
        });

        const drive = google.drive({ version: 'v3', auth });
        const fileId = process.env.GOOGLE_FIELD_ID;
        const res = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' }
        );

        await new Promise((resolve, reject) => {
            let data = '';
            res.data
                .on('data', (chunk) => {
                    data += chunk.toString();
                })
                .on('end', () => {
                    fileContent = JSON.parse(data);
                    resolve();
                })
                .on('error', reject);
        });

    } catch (error) {
        console.error('Error in getKeyfromGDrive:', error);
        throw error;
    }
};

const main = async () => {
    try {
        await getKeyfromGDrive();
        if (!fileContent) return;

        const binance = new ccxt.binance({
            apiKey: fileContent.apiKey,
            secret: fileContent.secretKey,
            options: {
                recvWindow: 60000
            },
        });

        binance.setSandboxMode(true); // Enable sandbox mode

        while (true) {
            await order(binance);
            await delay(60000); // Wait 1 minute
        }

    } catch (error) {
        console.error('Error in main:', error);
    }
};

main();
