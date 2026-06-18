const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').trim();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const sessions = {};
let doc;

async function initGoogleSheets() {
    try {
        const credsFile = fs.readFileSync('./credentials.json', 'utf8');
        const creds = JSON.parse(credsFile);

        const jwt = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        doc = new GoogleSpreadsheet(SPREADSHEET_ID, jwt);
        await doc.loadInfo();
        
        if (!doc.sheetsByTitle['AuthorizedUsers']) {
            await doc.addSheet({ title: 'AuthorizedUsers', headerValues: ['Phone', 'Name'] });
        }
        console.log(`Successfully connected to Google Sheet: ${doc.title}`);
    } catch (error) {
        console.error('Error connecting to Google Sheets. Ensure credentials.json is present.', error.message);
    }
}

async function isUserAuthorized(phone) {
    if (phone === ADMIN_NUMBER) return 'Admin';
    if (!doc) return false;
    
    const sheet = doc.sheetsByTitle['AuthorizedUsers'];
    if (!sheet) return false;
    
    const rows = await sheet.getRows();
    const user = rows.find(r => r.get('Phone') === phone);
    if (user) return user.get('Name');
    
    return false;
}

async function logUserExpense(userName, amount, description, category, customDate) {
    let sheet = doc.sheetsByTitle[userName];
    if (!sheet) {
        sheet = await doc.addSheet({ title: userName, headerValues: ['Timestamp', 'Description', 'Amount', 'Category'] });
    }
    const timestamp = customDate || new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    await sheet.addRow({ Timestamp: timestamp, Description: description, Amount: amount, Category: category });
}

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: '/.wwebjs_auth' }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('Scan the QR Code below to authenticate your DEDICATED bot account:');
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('WhatsApp Client is ready!');
    if (!doc) await initGoogleSheets();
});

async function askForOwners(msg, session) {
    const item = session.items[session.currentItemIndex];
    let prompt = `Who shared the *${item.name}* (Rp ${item.price.toLocaleString('id-ID')})?\n\nReply with numbers:\n`;
    session.participants.forEach((p, idx) => {
        prompt += `${idx + 1}. ${p}\n`;
    });
    await msg.reply(prompt);
}

async function calculateSplitBill(msg, session, userName) {
    const debts = {};
    session.participants.forEach(p => debts[p] = 0);
    
    session.items.forEach(item => {
        const perPerson = item.price / item.owners.length;
        item.owners.forEach(o => {
            if (debts[o] !== undefined) debts[o] += perPerson;
            else debts[o] = perPerson;
        });
    });
    
    let report = `🧾 *Split Bill Summary*\n\n`;
    report += `*Items:*\n`;
    session.items.forEach(item => {
        report += `- ${item.name} (Rp ${item.price.toLocaleString('id-ID')}): ${item.owners.join(', ')}\n`;
    });
    report += `\n*Totals:*\n`;
    for (const [p, amt] of Object.entries(debts)) {
        if (amt > 0) report += `- ${p} owes ${userName}: Rp ${Math.round(amt).toLocaleString('id-ID')}\n`;
    }
    await msg.reply(report);
    delete sessions[msg.from];
}

async function handleSplitBill(msg, userName) {
    const session = sessions[msg.from];
    const text = msg.body.trim();
    
    try {
        if (session.state === 'AWAITING_RECEIPT') {
            if (!msg.hasMedia) {
                await msg.reply("Please send a photo of the receipt. If you want to cancel, type 'cancel'.");
                if (text.toLowerCase() === 'cancel') delete sessions[msg.from];
                return;
            }
            const media = await msg.downloadMedia();
            if (!media) {
                await msg.reply("Failed to download image. Try again.");
                return;
            }
            
            await msg.reply("Reading receipt with AI... 🤖 Please wait a moment.");
            
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
            const prompt = "Extract all food and beverage line items from this receipt. Return a JSON array where each object has 'name' (string) and 'price' (number). Do not include tax or subtotal, only the items. Respond ONLY with the JSON array, no markdown formatting. Ensure numbers are integers.";
            
            const imageParts = [
                {
                    inlineData: {
                        data: media.data,
                        mimeType: media.mimetype
                    }
                }
            ];
            
            const result = await model.generateContent([prompt, ...imageParts]);
            const responseText = result.response.text().trim().replace(/```json/g, '').replace(/```/g, '');
            const items = JSON.parse(responseText);
            
            if (!items || items.length === 0) throw new Error("No items found");
            
            session.items = items.map(item => ({ name: item.name, price: item.price, owners: [] }));
            session.state = 'AWAITING_PARTICIPANTS';
            await msg.reply(`Found ${items.length} items! 🎉\n\nWho is sharing this bill? Send a comma-separated list of names (e.g., Alice, Bob, Charlie).`);
            
        } 
        else if (session.state === 'AWAITING_PARTICIPANTS') {
            session.participants = text.split(',').map(n => n.trim());
            session.currentItemIndex = 0;
            session.state = 'ASSIGNING_OWNERS';
            
            await askForOwners(msg, session);
        } 
        else if (session.state === 'ASSIGNING_OWNERS') {
            if (text.toLowerCase() === 'cancel') {
                delete sessions[msg.from];
                await msg.reply("Cancelled split bill.");
                return;
            }
            
            const item = session.items[session.currentItemIndex];
            const ownerIndexes = text.split(/\s+/).map(n => parseInt(n, 10) - 1);
            
            let validOwners = [];
            ownerIndexes.forEach(idx => {
                if (session.participants[idx]) validOwners.push(session.participants[idx]);
            });
            
            if (validOwners.length === 0) {
                await msg.reply(`Please reply with valid numbers from the list (e.g. '1 2').`);
                return;
            }
            
            item.owners = validOwners;
            
            session.currentItemIndex++;
            if (session.currentItemIndex >= session.items.length) {
                await calculateSplitBill(msg, session, userName);
            } else {
                await askForOwners(msg, session);
            }
        }
    } catch (e) {
        console.error("Gemini/SplitBill Error:", e);
        await msg.reply("Sorry, I couldn't read the receipt clearly. Please type 'cancel' to exit, or upload a clearer photo.");
        if (text.toLowerCase() === 'cancel') delete sessions[msg.from];
    }
}

client.on('message', async (msg) => {
    console.log("\n======================================");
    console.log("DEBUG: INCOMING MESSAGE RECEIVED");
    console.log("-> msg.from: '" + msg.from + "'");
    console.log("-> ADMIN_NUMBER loaded from .env: '" + ADMIN_NUMBER + "'");
    console.log("-> Exact match? :", msg.from === ADMIN_NUMBER);
    console.log("======================================\n");
    
    try {
        if (!doc) await initGoogleSheets();
        
        const userName = await isUserAuthorized(msg.from);
        if (!userName) {
            await msg.reply("⛔ Unauthorized. Please ask the Admin to add your number.");
            return;
        }

        if (sessions[msg.from]) {
            await handleSplitBill(msg, userName);
            return;
        }

        const text = msg.body.trim().toLowerCase();
        
        const helpKeywords = ['hi', 'hello', 'help', 'halo', 'p', '/help'];
        if (helpKeywords.includes(text)) {
            await msg.reply("Hello! \ud83d\udc4b I am your Money Robot! \ud83e\udd16\ud83d\udcb0\n\nHere is how we can play:\n\n1\u20e3 *Save Money:* Start with /log then tell me what you bought!\n_(Say: '/log 50k for ice cream' \ud83c\udf66)_\n\n2\u20e3 *Check Piggy Bank:* Want to see your money?\n_(Type: '/summary today' or '/summary mtd' \ud83d\udc37)_\n\n3\u20e3 *Share Food:* Ate with friends? I can do the math!\n_(Type: '/splitbill' \ud83c\udf55)_\n\n4\u20e3 *Add Friends (Boss Only):*\n_(Type: '/adduser [number] [name]' \ud83d\udc51)_");
            return;
        }

        if (!msg.body.startsWith('/')) return;

        const rawArgs = msg.body.split(' ');
        const command = rawArgs[0].toLowerCase();
        const argsText = rawArgs.slice(1).join(' ').trim();

        if (command === '/adduser') {
            if (msg.from !== ADMIN_NUMBER) {
                await msg.reply("⛔ Boss Only! You don't have permission.");
                return;
            }
            if (rawArgs.length < 3) {
                await msg.reply("Usage: `/adduser [phone@c.us] [name]`");
                return;
            }
            const phone = rawArgs[1];
            const name = rawArgs.slice(2).join(' ');
            
            const sheet = doc.sheetsByTitle['AuthorizedUsers'];
            await sheet.addRow({ Phone: phone, Name: name });
            
            const waUrl = `https://wa.me/${client.info.wid.user}?text=hi`;
            const qrData = await QRCode.toDataURL(waUrl);
            const media = new MessageMedia('image/png', qrData.split(',')[1], 'bot_qr.png');
            
            await msg.reply(media, undefined, { caption: `✅ Added ${name}.\nThey can scan this QR or go to ${waUrl} to talk to me!` });
        } 
        else if (command === '/log') {
            const amountRegex = /(\d+)(?:\s*(k|rb|ribu))?/i;
            const match = argsText.match(amountRegex);
            if (!match) {
                await msg.reply("Couldn't find an amount. Try '/log 50k pizza'");
                return;
            }

            let amount = parseInt(match[1], 10);
            if (match[2] && ['k', 'rb', 'ribu'].includes(match[2].toLowerCase())) amount *= 1000;
            let description = argsText.replace(match[0], '').trim() || 'No description';

            let customDate = null;
            const dateRegex = /\s+((?:yesterday|kemarin)|(?:\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)|(?:\d{1,2}\s+(?:jan|feb|mar|apr|may|mei|jun|jul|aug|agu|sep|oct|okt|nov|dec|des)[a-z]*\s*\d{0,4}))$/i;
            const dateMatch = description.match(dateRegex);
            if (dateMatch) {
                // Keep the exact format the user typed
                customDate = dateMatch[1];
                description = description.replace(dateRegex, '').trim() || 'No description';
            }

            const CATEGORIES = {
                'Food & Beverage': ['makan', 'minum', 'kopi', 'nasi', 'gofood', 'grabfood', 'mcd'],
                'Groceries': ['aeon', 'supermarket', 'indomaret', 'alfamart', 'sayur'],
                'Transportation': ['bensin', 'grab', 'gojek', 'tol', 'parkir', 'pertamax'],
                'Utilities': ['listrik', 'token', 'internet', 'pulsa', 'air']
            };
            let category = 'Miscellaneous';
            for (const [cat, keys] of Object.entries(CATEGORIES)) {
                if (keys.some(k => argsText.toLowerCase().includes(k))) {
                    category = cat; break;
                }
            }

            await logUserExpense(userName, amount, description, category, customDate);
            await msg.reply(`✅ Recorded!\nDesc: ${description}\nCat: ${category}\nAmt: Rp ${amount.toLocaleString('id-ID')}\nDate: ${customDate || 'Today'}`);
        }
        else if (command === '/summary') {
            const sheet = doc.sheetsByTitle[userName];
            if (!sheet) {
                await msg.reply("No expenses logged yet!");
                return;
            }
            const rows = await sheet.getRows();
            let total = 0;
            const catTotals = {};
            
            rows.forEach(r => {
                const amt = parseFloat(r.get('Amount'));
                if (!isNaN(amt)) {
                    total += amt;
                    const cat = r.get('Category');
                    catTotals[cat] = (catTotals[cat] || 0) + amt;
                }
            });

            let res = `📊 *Summary*\nTotal: Rp ${total.toLocaleString('id-ID')}\n\n`;
            for (const [c, a] of Object.entries(catTotals)) {
                res += `${c}: Rp ${a.toLocaleString('id-ID')}\n`;
            }
            await msg.reply(res);
        }
        else if (command === '/splitbill') {
            sessions[msg.from] = { state: 'AWAITING_RECEIPT' };
            await msg.reply("Alright! Send me a photo of the receipt to get started.");
        }
    } catch (e) {
        console.error(e);
        await msg.reply("❌ Error: " + e.message);
    }
});

initGoogleSheets().then(() => client.initialize());
