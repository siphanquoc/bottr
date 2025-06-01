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
const dcaInterval = 60000; // 1 phút (bạn có thể chỉnh lại)
const MIN_ORDER_SIZE = 0.001; // Min order size 0.001 BTC của Binance Futures

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
        res.data.on('data', chunk => data += chunk.toString());
        res.data.on('end', () => {
            fileContent = JSON.parse(data);
            resolve();
        });
        res.data.on('error', reject);
    });
};

const getLastPrice = async (binance) => {
    const ticker = await binance.fetchTicker('BTC/USDT');
    return ticker.last;
};

const placeDCAOrder = async (binance) => {
    try {
        const lastPrice = await getLastPrice(binance);
        const balanceBefore = await binance.fetchBalance();
        const totalBefore = balanceBefore.total.BTC * lastPrice + balanceBefore.total.USDT;

        let info = {
            time: moment().format('YYYY-MM-DD HH:mm:ss'),
            balanceBefore: {
                BTC: balanceBefore.total.BTC,
                USDT: balanceBefore.total.USDT,
                totalUSD: totalBefore
            }
        };

        if (balanceBefore.total.USDT < dcaAmount) {
            info.action = 'hold';
            info.reason = 'Insufficient USDT balance';

            const balanceAfter = await binance.fetchBalance();
            const totalAfter = balanceAfter.total.BTC * lastPrice + balanceAfter.total.USDT;
            info.balanceAfter = {
                BTC: balanceAfter.total.BTC,
                USDT: balanceAfter.total.USDT,
                totalUSD: totalAfter
            };

            console.log(`⏸️ HOLD - Không đủ USDT để mua.`);
            await logInfo(info);
            return;
        }

        const quantity = dcaAmount / lastPrice;

        if (quantity < MIN_ORDER_SIZE) {
            info.action = 'hold';
            info.reason = `Order size too small: ${quantity.toFixed(6)} BTC < min order size ${MIN_ORDER_SIZE}`;

            const balanceAfter = await binance.fetchBalance();
            const totalAfter = balanceAfter.total.BTC * lastPrice + balanceAfter.total.USDT;
            info.balanceAfter = {
                BTC: balanceAfter.total.BTC,
                USDT: balanceAfter.total.USDT,
                totalUSD: totalAfter
            };

            console.log(`⏸️ HOLD - Số lượng mua nhỏ hơn ${MIN_ORDER_SIZE} BTC.`);
            await logInfo(info);
            return;
        }

        const order = await binance.createMarketBuyOrder('BTC/USDT', quantity);

        const balanceAfter = await binance.fetchBalance();
        const totalAfter = balanceAfter.total.BTC * lastPrice + balanceAfter.total.USDT;

        info.action = 'buy';
        info.quantity = quantity;
        info.price = lastPrice;
        info.orderId = order.id;
        info.balanceAfter = {
            BTC: balanceAfter.total.BTC,
            USDT: balanceAfter.total.USDT,
            totalUSD: totalAfter
        };

        console.log(`✅ DCA BUY ${quantity.toFixed(6)} BTC @ $${lastPrice}`);
        console.log(`Total Balance Before: $${totalBefore.toFixed(2)}, After: $${totalAfter.toFixed(2)}`);
        await logInfo(info);

    } catch (err) {
        console.error('❌ DCA Order Failed:', err.message);
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
                }
            }
        });

        // Binance Futures testnet không hỗ trợ setSandboxMode nên không gọi hàm này
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
