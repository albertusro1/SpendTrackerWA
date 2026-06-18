#!/bin/bash

# Exit script on any error
set -e

echo "==================================================="
echo "  Starting DEDICATED Finance Bot Deployment Script  "
echo "==================================================="

# ---------------------------------------------------------
# PHASE 1: SYSTEM UPDATE & DOCKER ENGINE INSTALLATION
# ---------------------------------------------------------
echo "[Phase 1] Updating system and installing Docker..."

sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo systemctl enable docker
sudo systemctl start docker

# ---------------------------------------------------------
# PHASE 2: DIRECTORY ARCHITECTURE CREATION
# ---------------------------------------------------------
echo "[Phase 2] Creating repository directory architecture..."

mkdir -p ~/wa-finance-bot/auth_session
cd ~/wa-finance-bot

# ---------------------------------------------------------
# PHASE 3: APPLICATION FILE GENERATION
# ---------------------------------------------------------
echo "[Phase 3] Generating application files..."

# 1. package.json
cat << 'EOF' > package.json
{
  "name": "wa-finance-bot",
  "version": "2.0.0",
  "description": "Dedicated WhatsApp Personal Finance Bot with Gemini AI",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@google/generative-ai": "^0.24.1",
    "google-auth-library": "^9.11.0",
    "google-spreadsheet": "^4.1.4",
    "pino": "^9.0.0",
    "qrcode": "^1.5.3",
    "qrcode-terminal": "^0.12.0",
    "@whiskeysockets/baileys": "^6.7.0"
  }
}
EOF

# 2. Dockerfile
cat << 'EOF' > Dockerfile
FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git \
    fonts-kacst \
    fonts-freefont-ttf \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Asia/Jakarta
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

CMD ["node", "index.js"]
EOF

# 3. .dockerignore
cat << 'EOF' > .dockerignore
auth_session/
node_modules/
EOF

# 4. .env template
cat << 'EOF' > .env
SPREADSHEET_ID=your_spreadsheet_id_placeholder
ADMIN_NUMBER=6281234567890@c.us
GEMINI_API_KEY=your_gemini_api_key_placeholder
EOF

# 5. docker-compose.yml
cat << 'EOF' > docker-compose.yml
services:
  wa-finance-bot:
    build: .
    restart: always
    shm_size: '1g'
    volumes:
      - ./auth_session:/.wwebjs_auth
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - NODE_OPTIONS="--dns-result-order=ipv4first"
      - GEMINI_API_KEY=${GEMINI_API_KEY}
    deploy:
      resources:
        limits:
          memory: 512M
EOF

# 6. index.js
cat << 'EOF' > index.js
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
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
    if (typeof textOrMedia === 'string') {
        return await sock.sendMessage(msg.key.remoteJid, { text: textOrMedia, ...options }, { quoted: msg });
    } else {
        return await sock.sendMessage(msg.key.remoteJid, { ...textOrMedia, ...options }, { quoted: msg });
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

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ["Finance Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                startWhatsAppBot();
            }
        } else if (connection === 'open') {
            console.log('WhatsApp Client is ready! Connected with Baileys 🚀');
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
        console.log("-> msg.from: '" + from + "'");
        console.log("-> ADMIN_NUMBER loaded from .env: '" + ADMIN_NUMBER + "'");
        console.log("-> Exact match? :", from === ADMIN_NUMBER);
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

EOF

echo "[Phase 3] Application files generated successfully."

# ---------------------------------------------------------
# PHASE 4: POST-INSTALLATION INSTRUCTIONS
# ---------------------------------------------------------
echo "==================================================="
echo "              DEPLOYMENT COMPLETE                  "
echo "==================================================="
echo "Please follow these exact instructions to launch your Dedicated Bot:"
echo ""
echo "1. Enter the new directory:"
echo "   cd ~/wa-finance-bot"
echo ""
echo "2. Populate your Google Service Account credentials:"
echo "   nano credentials.json"
echo ""
echo "3. Update your Environment Configurations:"
echo "   nano .env"
echo "   (Fill in your SPREADSHEET_ID, ADMIN_NUMBER, and GEMINI_API_KEY)"
echo ""
echo "4. Build the Docker infrastructure and start the bot in detached mode:"
echo "   docker compose up --build -d"
echo ""
echo "5. Scan the QR code using your new WhatsApp Business account:"
echo "   docker compose logs -f wa-finance-bot"
echo "==================================================="
