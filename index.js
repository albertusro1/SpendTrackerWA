const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

// Environment Variables
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ALLOWED_SENDER = process.env.ALLOWED_SENDER;

// 1. Google Sheets Authorization
let doc;
async function initGoogleSheets() {
    try {
        const credsFile = fs.readFileSync('./spend-tracker-apis-2f1df66442d0.json', 'utf8');
        const creds = JSON.parse(credsFile);

        const jwt = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        doc = new GoogleSpreadsheet(SPREADSHEET_ID, jwt);
        await doc.loadInfo();
        console.log(`Successfully connected to Google Sheet: ${doc.title}`);
    } catch (error) {
        console.error('Error connecting to Google Sheets. Ensure spend-tracker-apis-2f1df66442d0.json is present.', error.message);
    }
}

// 2. WhatsApp Client Initialization
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/.wwebjs_auth' }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Scan the QR Code below to authenticate:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('WhatsApp Client is ready!');
    if (!doc) {
        await initGoogleSheets();
    } else {
        try {
            await doc.loadInfo(); // verify bridge is alive
            console.log(`Google Sheets bridge verified: ${doc.title}`);
        } catch (error) {
            console.error('Error verifying Google Sheets bridge:', error.message);
        }
    }
});

// 3. Expense Parsing & Ingestion Engine
const CATEGORIES = {
    'Food & Beverage': ['makan', 'minum', 'kopi', 'nasi', 'gofood', 'grabfood', 'mcd'],
    'Groceries': ['aeon', 'supermarket', 'indomaret', 'alfamart', 'sayur'],
    'Transportation': ['bensin', 'grab', 'gojek', 'tol', 'parkir', 'pertamax'],
    'Utilities': ['listrik', 'token', 'internet', 'pulsa', 'air']
};

function parseExpenseMessage(text) {
    const normalized = text.toLowerCase();
    
    // Explicit Regex pattern to extract numerical amounts and multipliers
    const amountRegex = /(\d+)(?:\s*(k|rb|ribu))?/i;
    const match = normalized.match(amountRegex);
    
    if (!match) return null; // No amount found, not an expense log

    let amount = parseInt(match[1], 10);
    const multiplier = match[2];
    
    if (multiplier && ['k', 'rb', 'ribu'].includes(multiplier.toLowerCase())) {
        amount *= 1000;
    }

    // Extract Description (remove the amount matched from the original string)
    const description = text.replace(match[0], '').trim() || 'No description';

    // Assign Category
    let category = 'Miscellaneous';
    for (const [catName, keywords] of Object.entries(CATEGORIES)) {
        if (keywords.some(keyword => normalized.includes(keyword))) {
            category = catName;
            break;
        }
    }

    return { amount, description, category };
}

client.on('message_create', async (msg) => {
    // SECURITY GUARD: Ensure message is from you
    if (ALLOWED_SENDER && msg.from !== ALLOWED_SENDER) {
        return; 
    }

    // ROOM GUARD: Only listen in the dedicated group
    const chat = await msg.getChat();
    if (!chat.isGroup || chat.name !== 'Finance Tracker') {
        return; // Ignore all messages outside this group
    }

    const parsed = parseExpenseMessage(msg.body);
    if (!parsed) {
        return; // Message is not recognized as an expense log
    }

    // 4. Data Persistence & Messaging Feedback
    try {
        if (!doc) await initGoogleSheets();
        
        const sheet = doc.sheetsByIndex[0];
        
        // Indonesian locale timestamp
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        
        await sheet.addRow({
            Timestamp: timestamp,
            Description: parsed.description,
            Amount: parsed.amount,
            Category: parsed.category
        });

        // Format amount to IDR
        const formattedAmount = new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            minimumFractionDigits: 0
        }).format(parsed.amount);

        await msg.reply(`✅ Recorded!\nDesc: ${parsed.description}\nCat: ${parsed.category}\nAmt: ${formattedAmount}`);
        console.log(`Logged expense: ${formattedAmount} for ${parsed.description} in ${parsed.category}`);
        
    } catch (error) {
        console.error('Failed to log expense:', error);
        try {
            await msg.reply(`❌ Failed to log expense to Google Sheets.\nError: ${error.message}`);
        } catch (replyError) {
            console.error('Failed to send error reply:', replyError);
        }
    }
});

// Start initialization
initGoogleSheets().then(() => {
    console.log('Initializing WhatsApp Client...');
    client.initialize();
});
