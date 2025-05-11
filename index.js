const ccxt = require('ccxt');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const delay = require('delay');
const dotenv = require('dotenv');
const { google } = require('googleapis');
dotenv.config();

var fileContent = undefined

const printBalance = async (infoPrice) => {
    try {
        const logFolder = path.join('./', 'log'); // Define the log folder path
        if (!fs.existsSync(logFolder)) {
            fs.mkdirSync(logFolder); // Create the log folder if it doesn't exist
        }
        // Create a log file path based on the current date
        const logFilePath = path.join(logFolder, `log_${moment().format('YYYY-MM-DD')}.json`); // Create a unique file name based on the date    
        // Check if the log file already exists
        if (fs.existsSync(logFilePath)) {
            const existingData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
            existingData.unshift(infoPrice); // unshift new data to existing data
            fs.writeFileSync(logFilePath, JSON.stringify(existingData, null, 2), 'utf8'); // Write the updated data back to the file
        } else {
            fs.writeFileSync(logFilePath, JSON.stringify([infoPrice], null, 2), 'utf8'); // Create a new file with the log data
        }
        console.log(`Balance logged to ${logFilePath}`);
         
    } catch (error) {
        console.error('Error loading balance:', error);
    }
}

const order = async (binance) => {
    let size = 20; // Define the trade size (in BTC)
    const prices = await binance.fetchOHLCV('BTC/USDT', '1m', undefined, 5);
    const bPrice = prices.map(prise => {
        return {
            timestamp: moment(prise[0]).format('YYYY-MM-DD HH:mm:ss'),
            open: prise[1],
            high: prise[2],
            low: prise[3],
            close: prise[4],
            volume: prise[5]
        }
    })
    let infoPrice = {
        'listLastPrice': bPrice.map(price => price.close).join(', '),
    }
    const balance = await binance.fetchBalance();
    
    infoPrice.averagePrice = bPrice.reduce((acc, price) => acc + price.close, 0) / bPrice.length;
    infoPrice.lastPrice = bPrice[bPrice.length - 1].close;
    infoPrice.quantity = size / infoPrice.lastPrice; // Calculate the quantity based on the trade size and last price
    infoPrice.timestamp= moment().format('YYYY-MM-DD HH:mm:ss');

    infoPrice.direction = 'hold'; // Initialize direction to 'none'
    if (infoPrice.lastPrice > infoPrice.averagePrice && balance.total.BTC > 0) {
        if(balance.total.BTC < infoPrice.quantity) {
            infoPrice.quantity = balance.total.BTC
        }
        // infoPrice.quantity = balance.total.BTC
        infoPrice.direction = 'buy'; // Set direction to 'sell' if last price is greater than average price and BTC balance is greater than 0
    } else if (infoPrice.lastPrice < infoPrice.averagePrice && balance.total.USDT / infoPrice.lastPrice >= infoPrice.quantity) {
        infoPrice.direction = 'sell'; // Set direction to 'buy' if last price is less than average price and USDT balance is greater than 0
    } 
    
    if(infoPrice.direction !== 'hold') {
        await binance.createMarketOrder('BTC/USDT', infoPrice.direction, infoPrice.quantity); // Create a market order to buy or sell BTC/USDT
    }

    const balanceAfterOrder = await binance.fetchBalance();
    if (balanceAfterOrder) {
        infoPrice.balance = {
            BTC: balanceAfterOrder.total.BTC,
            USDT: balanceAfterOrder.total.USDT,
            totalUSDT : balanceAfterOrder.total.BTC * infoPrice.lastPrice + balanceAfterOrder.total.USDT
        }
    }

    await printBalance(infoPrice); // Call the printBalance function to log the balance
}


const getKeyfromGDrive = async () => {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: path.join('./', 'credentials.json'), // Path to your service account key file
            scopes: [process.env.GOOGLE_AUTH_SCOPES]
        });
        
        const drive = google.drive({ version: 'v3', auth });
        const fileId = process.env.GOOGLE_FIELD_ID;
        const res = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream' }
        );
        await new Promise((resolve, reject) => {
            res.data
                .on('data', (chunk) => {
                    fileContent = JSON.parse(chunk.toString()); // Append each chunk to the fileContent variable
                })
                .on('end', resolve)
                .on('error', reject);
        });
        
    } catch (error) {
        console.error('Error in getKeyfromGDrive:', error);
        throw error; // Re-throw the error to propagate it
    }
    
}

const main = async () => {
    try {
        await getKeyfromGDrive(); // Await the function to handle its promise
        if(!fileContent) return;
            const binance = new ccxt.binance({
                apiKey: fileContent.apiKey,
                secret: fileContent.secretKey,
                options: {
                    recvWindow: 60000 // Set recvWindow to 60 seconds (60000 ms)
                },
            });
        binance.setSandboxMode(true); 
        // Enable sandbox mode for testing
        // const order = await binance.createMarketOrder('ETH/USDT', 'buy', 40);
        while (true) {
            await order(binance); // Call the order function with the bPrice data
            await delay(60000); // Wait for 1 minute before the next iteration
        }
    } catch (error) {
        console.error('Error in main:', error);
    }
}

main()