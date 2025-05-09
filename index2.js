const asciichart = require ('asciichart')
const delay = require('delay');
const fs = require('fs');
const path = require('path');
const moment = require('moment');

const main = async () => {
    while (true) {
        await chartDoing();
        await delay(60000); // Wait for 1 minute before the next iteration
    }
}

const chartDoing = async () => {
    const logFolder = path.join('./', 'log');
    if (!fs.existsSync(logFolder)) return;
    
    const logFilePath = path.join(logFolder, `log_${moment().format('YYYY-MM-DD')}.json`);
    if(!fs.existsSync(logFilePath)) return;

    try {
        const existingData = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
        if (Array.isArray(existingData)) {
            const chartData = existingData.map(obj => obj.balance.totalUSDT)

            if (chartData.length > 0) {
                console.clear(); // Clear the console for a fresh chart
                console.log(asciichart.plot(chartData, { height: 15 })); // Render the chart
            } else {
                console.error('No valid numeric data found for the chart.');
            }
        }
    } catch (error) {
        console.error('Error reading or parsing the JSON file:', error.message);
    }
}
main();