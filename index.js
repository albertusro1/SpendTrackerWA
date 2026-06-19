const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
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
let sock;

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

async function reply(msg, textOrMedia, options = {}) {
    try {
        // Try senderPn first, then remoteJid
        const primaryJid = msg.key.senderPn || msg.key.remoteJid;
        console.log("DEBUG REPLY: Trying JID:", primaryJid);
        let result;
        if (typeof textOrMedia === 'string') {
            result = await sock.sendMessage(primaryJid, { text: textOrMedia, ...options });
        } else {
            result = await sock.sendMessage(primaryJid, { ...textOrMedia, ...options });
        }
        console.log("DEBUG REPLY: Result:", JSON.stringify(result));
        return result;
    } catch (err) {
        console.error("DEBUG REPLY ERROR:", err.message || err);
        // Fallback: try the other JID
        try {
            const fallbackJid = msg.key.remoteJid;
            console.log("DEBUG REPLY FALLBACK: Trying:", fallbackJid);
            if (typeof textOrMedia === 'string') {
                return await sock.sendMessage(fallbackJid, { text: textOrMedia, ...options });
            } else {
                return await sock.sendMessage(fallbackJid, { ...textOrMedia, ...options });
            }
        } catch (err2) {
            console.error("DEBUG REPLY FALLBACK ERROR:", err2.message || err2);
        }
    }
}

async function askForOwners(msg, session, from) {
    const item = session.items[session.currentItemIndex];
    let prompt = `Who shared the *${item.name}* (Rp ${item.price.toLocaleString('id-ID')})?\n\nReply with numbers:\n`;
    session.participants.forEach((p, idx) => {
        prompt += `${idx + 1}. ${p}\n`;
    });
    await reply(msg, prompt);
}

async function calculateSplitBill(msg, session, userName, from) {
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
    await reply(msg, report);
    delete sessions[from];
}

async function handleSplitBill(msg, userName, from, text) {
    const session = sessions[from];
    
    try {
        if (session.state === 'AWAITING_RECEIPT') {
            const isImage = msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
            
            if (!isImage) {
                await reply(msg, "Please send a photo of the receipt. If you want to cancel, type 'cancel'.");
                if (text === 'cancel') delete sessions[from];
                return;
            }
            
            const targetMessage = msg.message?.imageMessage ? msg : { message: msg.message.extendedTextMessage.contextInfo.quotedMessage };
            const mimetype = targetMessage.message.imageMessage.mimetype;
            
            const buffer = await downloadMediaMessage(
                targetMessage,
                'buffer',
                {},
                { logger: pino({ level: 'silent' }) }
            );
            
            if (!buffer) {
                await reply(msg, "Failed to download image. Try again.");
                return;
            }
            
            await reply(msg, "Reading receipt with AI... 🤖 Please wait a moment.");
            
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
            const prompt = "Extract all food and beverage line items from this receipt. Return a JSON array where each object has 'name' (string) and 'price' (number). Do not include tax or subtotal, only the items. Respond ONLY with the JSON array, no markdown formatting. Ensure numbers are integers.";
            
            const imageParts = [
                {
                    inlineData: {
                        data: buffer.toString('base64'),
                        mimeType: mimetype
                    }
                }
            ];
            
            const result = await model.generateContent([prompt, ...imageParts]);
            const responseText = result.response.text().trim().replace(/```json/g, '').replace(/```/g, '');
            const items = JSON.parse(responseText);
            
            if (!items || items.length === 0) throw new Error("No items found");
            
            session.items = items.map(item => ({ name: item.name, price: item.price, owners: [] }));
            session.state = 'AWAITING_PARTICIPANTS';
            await reply(msg, `Found ${items.length} items! 🎉\n\nWho is sharing this bill? Send a comma-separated list of names (e.g., Alice, Bob, Charlie).`);
            
        } 
        else if (session.state === 'AWAITING_PARTICIPANTS') {
            session.participants = text.split(',').map(n => n.trim());
            session.currentItemIndex = 0;
            session.state = 'ASSIGNING_OWNERS';
            
            await askForOwners(msg, session, from);
        } 
        else if (session.state === 'ASSIGNING_OWNERS') {
            if (text === 'cancel') {
                delete sessions[from];
                await reply(msg, "Cancelled split bill.");
                return;
            }
            
            const item = session.items[session.currentItemIndex];
            const ownerIndexes = text.split(/\s+/).map(n => parseInt(n, 10) - 1);
            
            let validOwners = [];
            ownerIndexes.forEach(idx => {
                if (session.participants[idx]) validOwners.push(session.participants[idx]);
            });
            
            if (validOwners.length === 0) {
                await reply(msg, `Please reply with valid numbers from the list (e.g. '1 2').`);
                return;
            }
            
            item.owners = validOwners;
            
            session.currentItemIndex++;
            if (session.currentItemIndex >= session.items.length) {
                await calculateSplitBill(msg, session, userName, from);
            } else {
                await askForOwners(msg, session, from);
            }
        }
    } catch (e) {
        console.error("Gemini/SplitBill Error:", e);
        await reply(msg, "Sorry, I couldn't read the receipt clearly. Please type 'cancel' to exit, or upload a clearer photo.");
        if (text === 'cancel') delete sessions[from];
    }
}

async function startWhatsAppBot() {
    await initGoogleSheets();

    const { state, saveCreds } = await useMultiFileAuthState('/.wwebjs_auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'info' }),
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        markOnlineOnConnect: true,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Scan the QR Code below to authenticate your DEDICATED bot account:');
            require('qrcode-terminal').generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            console.error("Connection Closed!", lastDisconnect.error);
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log("Reconnecting in 5 seconds...");
                setTimeout(startWhatsAppBot, 5000); 
            }
        } else if (connection === 'open') {
            console.log('WhatsApp Client is ready! Connected with Baileys 🚀');
            console.log('Bot identity:', JSON.stringify(sock.user));
            
            // Announce presence to WhatsApp servers
            await sock.sendPresenceUpdate('available');
            console.log("Presence set to 'available'");
            
            // Auto-send a test message to admin after presence is set
            setTimeout(async () => {
                try {
                    // Also set presence for this specific chat
                    await sock.presenceSubscribe('6282114003078@s.whatsapp.net');
                    await sock.sendPresenceUpdate('composing', '6282114003078@s.whatsapp.net');
                    
                    console.log("AUTO-TEST: Sending test message...");
                    const res = await sock.sendMessage('6282114003078@s.whatsapp.net', { text: '🤖 Bot is online and ready!' });
                    console.log("AUTO-TEST Result:", JSON.stringify(res));
                    
                    await sock.sendPresenceUpdate('paused', '6282114003078@s.whatsapp.net');
                } catch(e) {
                    console.error("AUTO-TEST ERROR:", e.message);
                }
            }, 5000);
        }
    });

    // Track message delivery status
    sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
            console.log("MSG STATUS UPDATE:", JSON.stringify(update));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // Convert @s.whatsapp.net to @c.us for backward compatibility with existing sheet logic
        const from = msg.key.remoteJid.replace('@s.whatsapp.net', '@c.us');
        const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
        const text = rawText.trim().toLowerCase();

        console.log("\n======================================");
        console.log("DEBUG: INCOMING MESSAGE RECEIVED");
        console.log("-> msg.key:", JSON.stringify(msg.key));
        console.log("-> from (converted):", from);
        console.log("-> ADMIN_NUMBER:", ADMIN_NUMBER);
        console.log("-> Exact match?:", from === ADMIN_NUMBER);
        console.log("-> rawText:", rawText);
        console.log("======================================\n");
        
        try {
            if (!doc) await initGoogleSheets();
            
            const userName = await isUserAuthorized(from);
            if (!userName) {
                await reply(msg, "⛔ Unauthorized. Please ask the Admin to add your number.");
                return;
            }

            if (sessions[from]) {
                await handleSplitBill(msg, userName, from, text);
                return;
            }

            const helpKeywords = ['hi', 'hello', 'help', 'halo', 'p', '/help'];
            if (helpKeywords.includes(text)) {
                await reply(msg, "Hello! 👋 I am your Money Robot! 🤖💰\n\nHere is how we can play:\n\n1️⃣ *Save Money:* Start with /log then tell me what you bought!\n_(Say: '/log 50k for ice cream' 🍦)_\n\n2️⃣ *Check Piggy Bank:* Want to see your money?\n_(Type: '/summary today' or '/summary mtd' 🐷)_\n\n3️⃣ *Share Food:* Ate with friends? I can do the math!\n_(Type: '/splitbill' 🍕)_\n\n4️⃣ *Add Friends (Boss Only):*\n_(Type: '/adduser [number] [name]' 👑)_");
                return;
            }

            if (!rawText.startsWith('/')) return;

            const rawArgs = rawText.split(' ');
            const command = rawArgs[0].toLowerCase();
            const argsText = rawArgs.slice(1).join(' ').trim();

            if (command === '/adduser') {
                if (from !== ADMIN_NUMBER) {
                    await reply(msg, "⛔ Boss Only! You don't have permission.");
                    return;
                }
                if (rawArgs.length < 3) {
                    await reply(msg, "Usage: `/adduser [phone@c.us] [name]`");
                    return;
                }
                const phone = rawArgs[1];
                const name = rawArgs.slice(2).join(' ');
                
                const sheet = doc.sheetsByTitle['AuthorizedUsers'];
                await sheet.addRow({ Phone: phone, Name: name });
                
                const waUrl = `https://wa.me/${sock.user.id.split(':')[0]}?text=hi`;
                const qrData = await QRCode.toDataURL(waUrl);
                
                await reply(msg, {
                    image: Buffer.from(qrData.split(',')[1], 'base64'),
                    caption: `✅ Added ${name}.\nThey can scan this QR or go to ${waUrl} to talk to me!`
                });
            } 
            else if (command === '/log') {
                const amountRegex = /(\d+)(?:\s*(k|rb|ribu))?/i;
                const match = argsText.match(amountRegex);
                if (!match) {
                    await reply(msg, "Couldn't find an amount. Try '/log 50k pizza'");
                    return;
                }

                let amount = parseInt(match[1], 10);
                if (match[2] && ['k', 'rb', 'ribu'].includes(match[2].toLowerCase())) amount *= 1000;
                let description = argsText.replace(match[0], '').trim() || 'No description';

                let customDate = null;
                const dateRegex = /\s+((?:yesterday|kemarin)|(?:\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)|(?:\d{1,2}\s+(?:jan|feb|mar|apr|may|mei|jun|jul|aug|agu|sep|oct|okt|nov|dec|des)[a-z]*\s*\d{0,4}))$/i;
                const dateMatch = description.match(dateRegex);
                if (dateMatch) {
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
                await reply(msg, `✅ Recorded!\nDesc: ${description}\nCat: ${category}\nAmt: Rp ${amount.toLocaleString('id-ID')}\nDate: ${customDate || 'Today'}`);
            }
            else if (command === '/summary') {
                const sheet = doc.sheetsByTitle[userName];
                if (!sheet) {
                    await reply(msg, "No expenses logged yet!");
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
                await reply(msg, res);
            }
            else if (command === '/splitbill') {
                sessions[from] = { state: 'AWAITING_RECEIPT' };
                await reply(msg, "Alright! Send me a photo of the receipt to get started.");
            }
        } catch (e) {
            console.error(e);
            await reply(msg, "❌ Error: " + e.message);
        }
    });
}

startWhatsAppBot();
