const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const delay = require('delay');
const dotenv = require('dotenv');
const { google } = require('googleapis');

dotenv.config();

let fileContent = undefined;
const logDir = './logFU';

const dcaAmount = 20; // USD mỗi lần mua
const dcaInterval = 60000; // 1 phut

if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

const logInfo = async (info) => {
    const logFilePath = path.join(logDir, `log_${moment().format('YYYY-MM-DD')}.json`);
    const existing = fs.existsSync(logFilePath) ? JSON.parse(fs.readFileSync(logFilePath)) : [];
    existing.unshift(info);
    fs.writeFileSync(logFilePath, JSON.stringify(existing, null, 2));
};

const getKeyFromGDrive = async () => {
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
        res.data.on('data', (chunk) => (data += chunk.toString()));
        res.data.on('end', () => {
            fileContent = JSON.parse(data);
            resolve();
        });
        res.data.on('error', reject);
    });
};

const getLastPrice = async (binanceFutures) => {
    const ticker = await binanceFutures.fetchTicker('BTC/USDT');
    return ticker.last;
};

const placeDCAOrder = async (binanceFutures) => {
    try {
        const lastPrice = await getLastPrice(binanceFutures);

        const balanceBefore = await binanceFutures.fetchBalance();
        const totalBefore = balanceBefore.total.BTC * lastPrice + balanceBefore.total.USDT;

        let info = {
            time: moment().format('YYYY-MM-DD HH:mm:ss'),
            balanceBefore: {
                BTC: balanceBefore.total.BTC,
                USDT: balanceBefore.total.USDT,
                totalUSD: totalBefore,
            },
        };

        if (balanceBefore.total.USDT < dcaAmount) {
            info.action = 'hold';
            info.reason = 'Insufficient USDT balance';

            const balanceAfter = await binanceFutures.fetchBalance();
            const totalAfter = balanceAfter.total.BTC * lastPrice + balanceAfter.total.USDT;
            info.balanceAfter = {
                BTC: balanceAfter.total.BTC,
                USDT: balanceAfter.total.USDT,
                totalUSD: totalAfter,
            };

            console.log(`⏸️ HOLD - Không đủ USDT để mua.`);
            await logInfo(info);
            return;
        }

        const quantity = dcaAmount / lastPrice;
        const roundedQuantity = Math.floor(quantity * 1000) / 1000;

        if (roundedQuantity < 0.001) {
            info.action = 'hold';
            info.reason = 'Quantity less than minimum lot size (0.001)';

            const balanceAfter = await binanceFutures.fetchBalance();
            const totalAfter = balanceAfter.total.BTC * lastPrice + balanceAfter.total.USDT;
            info.balanceAfter = {
                BTC: balanceAfter.total.BTC,
                USDT: balanceAfter.total.USDT,
                totalUSD: totalAfter,
            };

            console.log('⏸️ HOLD - Số lượng mua nhỏ hơn 0.001 BTC.');
            await logInfo(info);
            return;
        }

        const order = await binanceFutures.createMarketBuyOrder('BTC/USDT', roundedQuantity);

        const balanceAfter = await binanceFutures.fetchBalance();
        const totalAfter = balanceAfter.total.BTC * lastPrice + balanceAfter.total.USDT;

        info = {
            ...info,
            action: 'buy',
            quantity: roundedQuantity,
            price: lastPrice,
            orderId: order.id,
            balanceAfter: {
                BTC: balanceAfter.total.BTC,
                USDT: balanceAfter.total.USDT,
                totalUSD: totalAfter,
            },
        };

        console.log(`✅ BUY ${roundedQuantity.toFixed(6)} BTC @ $${lastPrice}`);
        console.log(`Total Balance Before: $${totalBefore.toFixed(2)}, After: $${totalAfter.toFixed(2)}`);
        await logInfo(info);
    } catch (err) {
        const errorInfo = {
            time: moment().format('YYYY-MM-DD HH:mm:ss'),
            action: 'error',
            message: err.message,
        };
        console.error('❌ Order Failed:', err.message);
        await logInfo(errorInfo);
    }
};

const main = async () => {
    try {
        await getKeyFromGDrive();
        if (!fileContent) {
            console.error('❌ Không lấy được API key từ Google Drive');
            return;
        }

        const binanceFutures = new ccxt.binance({
            apiKey: fileContent.apiKey,
            secret: fileContent.secretKey,
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

        binanceFutures.setSandboxMode(true);

        while (true) {
            await placeDCAOrder(binanceFutures);
            await delay(dcaInterval);
        }
    } catch (err) {
        console.error('❌ Error in main():', err.message);
    }
};

main();
