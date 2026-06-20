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
const msgStore = {};

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

// Parse Indonesian date format: "20/6/2026 17.15.00" or "20/6/2026, 17.15.00"
function parseIdDate(str) {
    if (!str) return null;
    try {
        const cleaned = str.replace(',', '').trim();
        const [datePart] = cleaned.split(' ');
        if (!datePart) return null;
        const parts = datePart.split('/');
        if (parts.length < 3) return null;
        const [d, m, y] = parts;
        return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    } catch (e) {
        return null;
    }
}

function getStartOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday start
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

async function reply(msg, textOrMedia, options = {}) {
    try {
        const jid = msg.key.remoteJid;
        console.log("DEBUG REPLY: Sending to JID:", jid);
        let result;
        if (typeof textOrMedia === 'string') {
            result = await sock.sendMessage(jid, { text: textOrMedia, ...options });
        } else {
            result = await sock.sendMessage(jid, { ...textOrMedia, ...options });
        }
        // Store message for error 463 retry re-encryption
        if (result?.key?.id && result?.message) {
            msgStore[result.key.id] = result.message;
        }
        console.log("DEBUG REPLY: Result status:", result?.status, "id:", result?.key?.id);
        return result;
    } catch (err) {
        console.error("DEBUG REPLY ERROR:", err.message || err);
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
            
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
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
        getMessage: async (key) => {
            if (msgStore[key.id]) {
                console.log('getMessage: Found stored message for retry', key.id);
                return msgStore[key.id];
            }
            return { conversation: '' };
        }
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
            console.log("Presence set to 'available'. Send 'hi' to test!");
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
                    'Food & Beverage': [
                        'makan', 'minum', 'kopi', 'nasi', 'ayam', 'bakso', 'sate', 'soto',
                        'rendang', 'gudeg', 'rawon', 'pecel', 'tempe', 'tahu', 'sambal',
                        'es teh', 'es jeruk', 'jus', 'susu', 'roti', 'kue', 'gorengan', 'martabak',
                        'gofood', 'grabfood', 'mcd', 'kfc', 'starbucks', 'chatime', 'warung',
                        'food', 'eat', 'lunch', 'dinner', 'breakfast', 'brunch', 'snack',
                        'coffee', 'tea', 'juice', 'milk', 'bread', 'cake', 'pizza', 'burger',
                        'rice', 'noodle', 'pasta', 'chicken', 'beef', 'fish', 'salad',
                        'restaurant', 'cafe', 'bistro', 'dine', 'meal', 'dessert', 'ice cream',
                        'boba', 'matcha', 'latte', 'espresso', 'americano', 'croissant',
                        'sandwich', 'wrap', 'sushi', 'ramen', 'donut', 'waffle', 'pancake',
                        'salt', 'chocolate', 'cookie', 'pastry', 'fries', 'padang',
                    ],
                    'Groceries': [
                        'supermarket', 'indomaret', 'alfamart', 'hypermart', 'aeon',
                        'sayur', 'buah', 'bumbu', 'sabun', 'shampo', 'tissue',
                        'grocery', 'market', 'store', 'mart', 'vegetable', 'fruit',
                    ],
                    'Transportation': [
                        'bensin', 'grab', 'gojek', 'tol', 'parkir', 'pertamax',
                        'taxi', 'uber', 'gas', 'fuel', 'train', 'bus', 'mrt',
                        'ojek', 'transjakarta', 'commuter', 'travel', 'toll',
                    ],
                    'Utilities': [
                        'listrik', 'token', 'internet', 'pulsa', 'air', 'pdam',
                        'electric', 'water', 'phone', 'wifi', 'bill', 'subscription',
                    ],
                    'Shopping': [
                        'baju', 'celana', 'sepatu', 'tas', 'jam', 'aksesori',
                        'clothes', 'shoes', 'bag', 'watch', 'shirt', 'pants',
                        'dress', 'fashion', 'shopee', 'tokopedia', 'lazada',
                    ],
                    'Health': [
                        'obat', 'dokter', 'rumah sakit', 'apotek', 'vitamin',
                        'medicine', 'doctor', 'hospital', 'pharmacy', 'clinic', 'gym',
                    ],
                    'Entertainment': [
                        'bioskop', 'film', 'game', 'netflix', 'spotify', 'youtube',
                        'movie', 'cinema', 'concert', 'ticket', 'karaoke',
                    ],
                };
                let category = 'Miscellaneous';
                const searchText = argsText.toLowerCase();
                for (const [cat, keys] of Object.entries(CATEGORIES)) {
                    if (keys.some(k => searchText.includes(k))) {
                        category = cat; break;
                    }
                }

                await logUserExpense(userName, amount, description, category, customDate);
                const catEmojis = { 'Food & Beverage': '🍔', 'Groceries': '🛒', 'Transportation': '🚗', 'Utilities': '⚡', 'Shopping': '🛍️', 'Health': '💊', 'Entertainment': '🎬', 'Miscellaneous': '📦' };
                await reply(msg, `✅ *Recorded!*\n\n📝 ${description}\n${catEmojis[category] || '📦'} ${category}\n💰 Rp ${amount.toLocaleString('id-ID')}\n📅 ${customDate || 'Today'}`);
            }
            else if (command === '/summary') {
                const sheet = doc.sheetsByTitle[userName];
                if (!sheet) {
                    await reply(msg, "No expenses logged yet!");
                    return;
                }
                const rows = await sheet.getRows();
                
                // Date filtering
                const filter = argsText.toLowerCase() || 'today';
                const now = new Date();
                const jakartaNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
                const todayStart = new Date(jakartaNow.getFullYear(), jakartaNow.getMonth(), jakartaNow.getDate());
                const weekStart = getStartOfWeek(jakartaNow);
                const monthStart = new Date(jakartaNow.getFullYear(), jakartaNow.getMonth(), 1);
                
                let filterStart = todayStart;
                let filterLabel = 'Today';
                if (filter === 'wtd' || filter === 'week') {
                    filterStart = weekStart;
                    filterLabel = 'This Week';
                } else if (filter === 'mtd' || filter === 'month') {
                    filterStart = monthStart;
                    filterLabel = 'Month to Date';
                } else if (filter === 'all') {
                    filterStart = new Date(0);
                    filterLabel = 'All Time';
                }
                
                const dateStr = jakartaNow.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
                
                let total = 0;
                let txCount = 0;
                const catData = {}; // { category: { total, items: [{desc, amt}] } }
                
                rows.forEach(r => {
                    const amt = parseFloat(r.get('Amount'));
                    if (isNaN(amt)) return;
                    
                    const rowDate = parseIdDate(r.get('Timestamp'));
                    if (rowDate && rowDate < filterStart) return;
                    
                    total += amt;
                    txCount++;
                    const cat = r.get('Category') || 'Miscellaneous';
                    const desc = r.get('Description') || 'No description';
                    if (!catData[cat]) catData[cat] = { total: 0, items: [] };
                    catData[cat].total += amt;
                    catData[cat].items.push({ desc, amt });
                });
                
                if (txCount === 0) {
                    await reply(msg, `📊 *Summary — ${filterLabel}*\n━━━━━━━━━━━━━━━━━\n\nNo expenses found for this period.`);
                    return;
                }
                
                const catEmojis = { 'Food & Beverage': '🍔', 'Groceries': '🛒', 'Transportation': '🚗', 'Utilities': '⚡', 'Shopping': '🛍️', 'Health': '💊', 'Entertainment': '🎬', 'Miscellaneous': '📦' };
                
                let res = `📊 *Summary — ${filterLabel} (${dateStr})*\n`;
                res += `━━━━━━━━━━━━━━━━━━━━━━\n`;
                res += `💰 *Total: Rp ${total.toLocaleString('id-ID')}*\n`;
                res += `📝 *Transactions: ${txCount}*\n\n`;
                res += `📂 *By Category:*\n`;
                
                // Sort categories by total descending
                const sorted = Object.entries(catData).sort((a, b) => b[1].total - a[1].total);
                
                for (const [cat, data] of sorted) {
                    const emoji = catEmojis[cat] || '📦';
                    const pct = Math.round((data.total / total) * 100);
                    res += `┌──────────────────\n`;
                    res += `│ ${emoji} *${cat}*\n`;
                    res += `│    Rp ${data.total.toLocaleString('id-ID')} (${data.items.length} item${data.items.length > 1 ? 's' : ''}, ${pct}%)\n`;
                    data.items.forEach(item => {
                        res += `│    • ${item.desc} — Rp ${item.amt.toLocaleString('id-ID')}\n`;
                    });
                    res += `└──────────────────\n`;
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
