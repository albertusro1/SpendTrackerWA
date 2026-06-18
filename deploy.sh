#!/bin/bash

# Exit script on any error
set -e

echo "==================================================="
echo "  Starting WhatsApp Finance Bot Deployment Script  "
echo "==================================================="

# ---------------------------------------------------------
# PHASE 1: SYSTEM UPDATE & DOCKER ENGINE INSTALLATION
# ---------------------------------------------------------
echo "[Phase 1] Updating system and installing Docker..."

# Update and install prerequisites
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Set up the repository
echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine, CLI, and Compose plugin
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Start and enable Docker
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
  "version": "1.0.0",
  "description": "WhatsApp Personal Finance Bot",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "google-auth-library": "^9.11.0",
    "google-spreadsheet": "^4.1.4",
    "qrcode-terminal": "^0.12.0",
    "whatsapp-web.js": "^1.26.0"
  }
}
EOF

# 2. Dockerfile
cat << 'EOF' > Dockerfile
FROM node:20-slim

# Install system-level Chromium and required font-rendering packages
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Environment variables for Puppeteer
ENV TZ=Asia/Jakarta
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Copy application source
COPY . .

CMD ["node", "index.js"]
EOF

# 3. docker-compose.yml
cat << 'EOF' > docker-compose.yml
services:
  wa-finance-bot:
    build: .
    restart: always
    shm_size: '1g'
    volumes:
      - ./auth_session:/.wwebjs_auth
    environment:
      - NODE_ENV=production
      - SPREADSHEET_ID=your_spreadsheet_id_placeholder
      - ALLOWED_SENDER=6281234567890@c.us
    deploy:
      resources:
        limits:
          memory: 512M
EOF

# 4. index.js
cat << 'EOF' > index.js
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
        const credsFile = fs.readFileSync('./credentials.json', 'utf8');
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
        console.error('Error connecting to Google Sheets. Ensure credentials.json is present and valid.', error.message);
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

client.on('message', async (msg) => {
    // SECURITY GUARD
    if (ALLOWED_SENDER && msg.from !== ALLOWED_SENDER) {
        return; // Silently abort to prevent unauthorized access
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
EOF

echo "[Phase 3] Application files generated successfully."

# ---------------------------------------------------------
# PHASE 4: POST-INSTALLATION INSTRUCTIONS
# ---------------------------------------------------------
echo "==================================================="
echo "              DEPLOYMENT COMPLETE                  "
echo "==================================================="
echo "Please follow these exact instructions to start your bot:"
echo ""
echo "1. Change into the newly created directory:"
echo "   cd ~/wa-finance-bot"
echo ""
echo "2. Populate your Google Service Account credentials:"
echo "   nano credentials.json"
echo "   (Paste your JSON credentials inside and save the file)"
echo ""
echo "3. Update your configurations:"
echo "   nano docker-compose.yml"
echo "   (Replace 'your_spreadsheet_id_placeholder' with your actual Spreadsheet ID)"
echo "   (Replace '6281234567890@c.us' with your actual WhatsApp phone number including the @c.us suffix)"
echo ""
echo "4. Build the Docker infrastructure and start the bot in detached mode:"
echo "   docker compose up --build -d"
echo ""
echo "5. Inspect the logs to scan the QR code:"
echo "   docker compose logs -f wa-finance-bot"
echo "==================================================="
