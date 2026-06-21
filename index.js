const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const moment = require('moment');
const cron = require('node-cron');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').trim();
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

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
    const receipt = session.receipts[session.currentReceiptIndex];
    const item = receipt.items[session.currentItemIndex];
    let prompt = `Who shared the *${item.name}* (Rp ${item.price.toLocaleString('id-ID')})?\n\nReply with numbers (e.g. '1, 2') or type 'all':\n`;
    receipt.participants.forEach((p, idx) => {
        prompt += `${idx + 1}. ${p}\n`;
    });
    await reply(msg, prompt);
}

function parsePayers(text, participants, totalBill, userName) {
    const cleaned = text.trim().toLowerCase();
    
    if (cleaned === 'me' || cleaned === 'i') {
        return [{ name: userName, amount: totalBill }];
    }
    
    const numIdx = parseInt(cleaned, 10);
    if (!isNaN(numIdx) && numIdx > 0 && numIdx <= participants.length) {
        return [{ name: participants[numIdx - 1], amount: totalBill }];
    }
    
    const parts = text.split(',');
    const results = [];
    let parsedTotal = 0;
    
    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        
        const match = trimmed.match(/^(.+?)(?:\s+(\d+)(?:\s*(k|rb|ribu))?)?$/i);
        if (match) {
            let nameOrNum = match[1].trim();
            let amount = match[2] ? parseInt(match[2], 10) : null;
            if (amount && match[3] && ['k', 'rb', 'ribu'].includes(match[3].toLowerCase())) {
                amount *= 1000;
            }
            
            const idx = parseInt(nameOrNum, 10);
            if (!isNaN(idx) && idx > 0 && idx <= participants.length) {
                nameOrNum = participants[idx - 1];
            }
            
            results.push({ name: nameOrNum, amount });
            if (amount) parsedTotal += amount;
        }
    }
    
    if (results.length === 0) {
        return null;
    }
    
    const withoutAmount = results.filter(r => r.amount === null);
    if (withoutAmount.length > 0) {
        const remaining = Math.max(0, totalBill - parsedTotal);
        const perPerson = remaining / withoutAmount.length;
        withoutAmount.forEach(r => r.amount = perPerson);
    }
    
    return results;
}

async function calculateSplitBill(msg, session, userName, from) {
    const allParticipants = new Set();
    session.receipts.forEach(r => {
        r.participants.forEach(p => allParticipants.add(p));
    });
    
    const consumptions = {};
    allParticipants.forEach(p => consumptions[p] = 0);
    
    session.receipts.forEach(r => {
        r.items.forEach(item => {
            if (item.owners.length === 0) return;
            const perPerson = item.price / item.owners.length;
            item.owners.forEach(o => {
                consumptions[o] = (consumptions[o] || 0) + perPerson;
            });
        });
    });
    
    const payments = {};
    session.receipts.forEach(r => {
        r.payers.forEach(p => {
            payments[p.name] = (payments[p.name] || 0) + p.amount;
        });
    });
    
    const allNames = new Set([...allParticipants, ...Object.keys(payments)]);
    const balances = {};
    allNames.forEach(name => {
        const cons = consumptions[name] || 0;
        const pay = payments[name] || 0;
        balances[name] = cons - pay;
    });
    
    const debtors = [];
    const creditors = [];
    for (const [name, bal] of Object.entries(balances)) {
        if (bal > 0.01) {
            debtors.push({ name, amount: bal });
        } else if (bal < -0.01) {
            creditors.push({ name, amount: -bal });
        }
    }
    
    const settlements = [];
    let dIdx = 0;
    let cIdx = 0;
    
    while (dIdx < debtors.length && cIdx < creditors.length) {
        const d = debtors[dIdx];
        const c = creditors[cIdx];
        const settleAmt = Math.min(d.amount, c.amount);
        
        settlements.push({
            from: d.name,
            to: c.name,
            amount: Math.round(settleAmt)
        });
        
        d.amount -= settleAmt;
        c.amount -= settleAmt;
        
        if (d.amount < 0.01) dIdx++;
        if (c.amount < 0.01) cIdx++;
    }
    
    let report = `🧾 *Split Bill Summary*\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    session.receipts.forEach((r, rIdx) => {
        const total = r.items.reduce((s, i) => s + i.price, 0);
        report += `*Bill ${rIdx + 1} (Total: Rp ${total.toLocaleString('id-ID')}):*\n`;
        r.items.forEach((item, idx) => {
            report += `  - ${item.name} (Rp ${item.price.toLocaleString('id-ID')}) — ${item.owners.join(', ')}\n`;
        });
        report += `  _Payer(s):_ ${r.payers.map(p => `${p.name} (Rp ${Math.round(p.amount).toLocaleString('id-ID')})`).join(', ')}\n\n`;
    });
    
    const grandTotal = session.receipts.reduce((sum, r) => sum + r.items.reduce((s, i) => s + i.price, 0), 0);
    report += `*Grand Total:* Rp ${grandTotal.toLocaleString('id-ID')}\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    report += `*Settlements (Who owes who):*\n`;
    if (settlements.length === 0) {
        report += `✅ Everyone is even! No transactions needed.`;
    } else {
        settlements.forEach(s => {
            report += `- *${s.from}* owes *${s.to}*: Rp ${s.amount.toLocaleString('id-ID')}\n`;
        });
    }
    
    // Calculate Consolidated Net-Off if there are multiple creditors
    const activeCreditors = [];
    const activeDebtors = [];
    
    for (const [name, bal] of Object.entries(balances)) {
        if (bal < -0.01) {
            activeCreditors.push({ name, amount: -bal });
        } else if (bal > 0.01) {
            activeDebtors.push({ name, amount: bal });
        }
    }
    
    // Sort creditors by amount descending (largest creditor/treasurer first)
    activeCreditors.sort((a, b) => b.amount - a.amount);
    
    if (activeCreditors.length > 1) {
        const consolidator = activeCreditors[0].name;
        let consolidatedReport = `\n━━━━━━━━━━━━━━━━━━━━\n🧾 *Consolidated Net-Off (Via ${consolidator})*\n\n`;
        consolidatedReport += `All debtors transfer to *${consolidator}*:\n`;
        
        activeDebtors.forEach(d => {
            consolidatedReport += `- *${d.name}* owes *${consolidator}*: Rp ${Math.round(d.amount).toLocaleString('id-ID')}\n`;
        });
        
        consolidatedReport += `\nThen, *${consolidator}* transfers to other creditors:\n`;
        
        for (let i = 1; i < activeCreditors.length; i++) {
            const c = activeCreditors[i];
            consolidatedReport += `- *${consolidator}* owes *${c.name}*: Rp ${Math.round(c.amount).toLocaleString('id-ID')}\n`;
        }
        
        report += consolidatedReport;
    }
    
    await reply(msg, report);
    delete sessions[from];
}

function parseLocalTextItems(text) {
    const lines = text.split(/[\n,]+/);
    const parsedItems = [];
    
    for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        
        let cleaned = line.replace(/^(rp\.?|rp\s*)/i, '').trim();
        cleaned = cleaned.replace(/(rp\.?|rp\s*)$/i, '').trim();
        
        const match = cleaned.match(/^(.+?)(?:\s+|:\s*|-\s*|rp\s*|rp\.\s*)(\d+(?:[\.,]\d{3})*)\s*(k|rb|ribu|juta|jt)?$/i);
        if (match) {
            const name = match[1].trim().replace(/^[:\-\s]+|[:\-\s]+$/g, '').trim();
            
            // Check word count and conversational keywords
            const nameWords = name.split(/\s+/);
            if (nameWords.length > 4) return null; // Fall back to LLM for long sentences
            
            const conversationalKeywords = ['bought', 'spent', 'paid', 'was', 'for', 'yesterday', 'kemarin', 'habis', 'tadi', 'bayar', 'spend', 'beli'];
            if (nameWords.some(w => conversationalKeywords.includes(w.toLowerCase()))) {
                return null; // Fall back to LLM
            }
            
            let priceStr = match[2].replace(/[\.,]/g, '');
            let price = parseInt(priceStr, 10);
            
            if (match[3]) {
                const mult = match[3].toLowerCase();
                if (['k', 'rb', 'ribu'].includes(mult)) {
                    price *= 1000;
                } else if (['juta', 'jt'].includes(mult)) {
                    price *= 1000000;
                }
            }
            
            if (name && !isNaN(price)) {
                parsedItems.push({ name, price });
            }
        } else {
            return null; // Fall back to LLM if any line is not simple format
        }
    }
    
    if (parsedItems.length > 0 && parsedItems.length === lines.filter(l => l.trim()).length) {
        return parsedItems;
    }
    return null;
}

function parseTaxInput(text) {
    const cleaned = text.trim().toLowerCase();
    
    if (cleaned === 'no' || cleaned === '0' || cleaned === 'none') {
        return { type: 'none' };
    }
    if (cleaned === 'yes' || cleaned === 'included' || cleaned === 'inc') {
        return { type: 'included' };
    }
    
    const pctMatch = cleaned.match(/^(\d+(?:\.\d+)?)\s*%/);
    if (pctMatch) {
        return { type: 'percent', value: parseFloat(pctMatch[1]) };
    }
    
    const amountRegex = /(\d+)(?:\s*(k|rb|ribu))?/i;
    const amtMatch = cleaned.match(amountRegex);
    if (amtMatch) {
        let amount = parseInt(amtMatch[1], 10);
        if (amtMatch[2] && ['k', 'rb', 'ribu'].includes(amtMatch[2].toLowerCase())) {
            amount *= 1000;
        }
        if (!amtMatch[2] && amount <= 100) {
            return { type: 'percent', value: amount };
        }
        return { type: 'amount', value: amount };
    }
    
    const val = parseFloat(cleaned);
    if (!isNaN(val)) {
        if (val <= 100) {
            return { type: 'percent', value: val };
        } else {
            return { type: 'amount', value: val };
        }
    }
    
    return null;
}

async function handleSplitBill(msg, userName, from, text) {
    const session = sessions[from];
    
    try {
        if (text.toLowerCase() === 'cancel') {
            delete sessions[from];
            await reply(msg, "❌ Split bill session cancelled.");
            return;
        }

        // Check if we are adding a receipt (either initial or subsequent)
        if (session.state === 'AWAITING_RECEIPT' || session.state === 'AWAITING_MORE_RECEIPTS') {
            const isImage = msg.message?.imageMessage || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
            
            // If in AWAITING_MORE_RECEIPTS and they typed 'no' or 'done', proceed to payment
            if (session.state === 'AWAITING_MORE_RECEIPTS' && !isImage && (text.toLowerCase() === 'no' || text.toLowerCase() === 'done')) {
                session.state = 'AWAITING_PAYERS';
                session.currentReceiptPayerIndex = 0;
                
                const currentReceipt = session.receipts[0];
                const total = currentReceipt.items.reduce((s, i) => s + i.price, 0);
                let prompt = `*Payer Details Required* 🧾\n\n`;
                prompt += `Who paid for *Bill 1* (Total: Rp ${total.toLocaleString('id-ID')})?\n\n`;
                prompt += `Reply with:\n`;
                prompt += `- A participant number:\n`;
                currentReceipt.participants.forEach((p, idx) => {
                    prompt += `  ${idx + 1}. ${p}\n`;
                });
                prompt += `- Any other name not in the list (e.g. David)\n`;
                prompt += `- Multiple payers with amounts (e.g. Alice 100k, Bob 50k)\n`;
                prompt += `- Or type 'me' to default to you (${userName}).`;
                await reply(msg, prompt);
                return;
            }

            let items = null;

            if (isImage) {
                // Image receipt input
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
                
                const openRouterKey = process.env.OPENROUTER_API_KEY;
                if (openRouterKey) {
                    console.log("Using OpenRouter for receipt scanning...");
                    const modelsToTry = [
                        "google/gemma-4-31b-it:free",
                        "nex-agi/nex-n2-pro:free",
                        "nvidia/nemotron-nano-12b-v2-vl:free",
                        "openrouter/free"
                    ];

                    let success = false;
                    let lastError = null;

                    for (const modelName of modelsToTry) {
                        let timeoutId;
                        try {
                            console.log(`Trying OpenRouter model: ${modelName}`);
                            const controller = new AbortController();
                            timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout

                            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                                method: "POST",
                                headers: {
                                    "Authorization": `Bearer ${openRouterKey}`,
                                    "Content-Type": "application/json",
                                    "HTTP-Referer": "https://github.com/albertusro1/SpendTrackerWA",
                                },
                                signal: controller.signal,
                                body: JSON.stringify({
                                    model: modelName,
                                    messages: [
                                        {
                                            role: "user",
                                            content: [
                                                {
                                                    type: "text",
                                                    text: "Extract all line items, services, products, or charges from this receipt. Return a JSON array where each object has 'name' (string) and 'price' (number). Distribute any tax, service charges, fees, or discounts proportionally to the item prices so that the sum of the parsed item prices equals the final grand total paid. Respond ONLY with the JSON array, no markdown formatting. Ensure numbers are integers."
                                                },
                                                {
                                                    type: "image_url",
                                                    image_url: {
                                                        url: `data:${mimetype};base64,${buffer.toString('base64')}`
                                                    }
                                                }
                                            ]
                                        }
                                    ]
                                })
                            });

                            clearTimeout(timeoutId);

                            if (!response.ok) {
                                const errText = await response.text();
                                throw new Error(`Status ${response.status} - ${errText}`);
                            }

                            const data = await response.json();
                            if (!data.choices || data.choices.length === 0) {
                                throw new Error("No choices returned from OpenRouter");
                            }

                            const responseText = data.choices[0].message.content.trim().replace(/```json/g, '').replace(/```/g, '');
                            items = JSON.parse(responseText);
                            success = true;
                            console.log(`Successfully parsed receipt using model: ${modelName}`);
                            break;
                        } catch (err) {
                            if (timeoutId) clearTimeout(timeoutId);
                            console.warn(`Failed with model ${modelName}:`, err.message);
                            lastError = err;
                        }
                    }

                    if (!success) {
                        throw new Error(`All OpenRouter models failed. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
                    }
                } else {
                    console.log("Using direct Gemini API for receipt scanning...");
                    if (!genAI) {
                        throw new Error("GEMINI_API_KEY is not configured in your .env file.");
                    }
                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                    const prompt = "Extract all line items, services, products, or charges from this receipt. Return a JSON array where each object has 'name' (string) and 'price' (number). Distribute any tax, service charges, fees, or discounts proportionally to the item prices so that the sum of the parsed item prices equals the final grand total paid. Respond ONLY with the JSON array, no markdown formatting. Ensure numbers are integers.";
                    
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
                    items = JSON.parse(responseText);
                }
            } else {
                // Text receipt input
                // First try to parse locally using the regex parser
                items = parseLocalTextItems(text);
                
                if (items) {
                    console.log("Parsed items locally via regex:", JSON.stringify(items));
                } else {
                    // If local parser fails, fall back to LLM
                    await reply(msg, "Parsing your items text... 🤖");
                    const openRouterKey = process.env.OPENROUTER_API_KEY;
                    const prompt = "Extract all line items, services, products, or charges from the following text description. Return a JSON array where each object has 'name' (string) and 'price' (number). Convert price shorthand notations like 'k', 'K', 'rb', 'ribu' to their full numeric values (e.g. 163k or 163K becomes 163000, 50k becomes 50000). Do not include tax, service charge, grand total, or subtotal if individual itemized list is present. If the text describes only a single expense, charge, or service without sub-items (e.g., 'Lapangan Badminton 163K'), treat that single charge as the line item. Respond ONLY with the JSON array, no markdown formatting. Ensure numbers are integers.\n\nInput text:\n" + text;

                    if (openRouterKey) {
                        console.log("Using OpenRouter for text items parsing...");
                        const modelsToTry = [
                            "meta-llama/llama-3.3-70b-instruct:free",
                            "google/gemma-4-31b-it:free",
                            "nex-agi/nex-n2-pro:free",
                            "openrouter/free"
                        ];

                        let success = false;
                        let lastError = null;

                        for (const modelName of modelsToTry) {
                            let timeoutId;
                            try {
                                console.log(`Trying OpenRouter model for text parsing: ${modelName}`);
                                const controller = new AbortController();
                                timeoutId = setTimeout(() => controller.abort(), 20000);

                                const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                                    method: "POST",
                                    headers: {
                                        "Authorization": `Bearer ${openRouterKey}`,
                                        "Content-Type": "application/json",
                                        "HTTP-Referer": "https://github.com/albertusro1/SpendTrackerWA",
                                    },
                                    signal: controller.signal,
                                    body: JSON.stringify({
                                        model: modelName,
                                        messages: [
                                            {
                                                role: "user",
                                                content: prompt
                                            }
                                        ]
                                    })
                                });

                                clearTimeout(timeoutId);

                                if (!response.ok) {
                                    const errText = await response.text();
                                    throw new Error(`Status ${response.status} - ${errText}`);
                                }

                                const data = await response.json();
                                if (!data.choices || data.choices.length === 0) {
                                    throw new Error("No choices returned from OpenRouter");
                                }

                                const responseText = data.choices[0].message.content.trim().replace(/```json/g, '').replace(/```/g, '');
                                items = JSON.parse(responseText);
                                success = true;
                                break;
                            } catch (err) {
                                if (timeoutId) clearTimeout(timeoutId);
                                console.warn(`Failed with model ${modelName} for text parsing:`, err.message);
                                lastError = err;
                            }
                        }

                        if (!success) {
                            throw new Error(`All OpenRouter models failed. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
                        }
                    } else {
                        console.log("Using direct Gemini API for text items parsing...");
                        if (!genAI) {
                            throw new Error("GEMINI_API_KEY is not configured in your .env file.");
                        }
                        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
                        const result = await model.generateContent(prompt);
                        const responseText = result.response.text().trim().replace(/```json/g, '').replace(/```/g, '');
                        items = JSON.parse(responseText);
                    }
                }
            }

            if (!items || items.length === 0) throw new Error("No items parsed");

            const newItems = items.map(item => ({ name: item.name, price: item.price, owners: [] }));
            
            if (!session.receipts) {
                session.receipts = [];
            }
            
            const newReceipt = {
                items: newItems,
                participants: [],
                payers: []
            };
            
            session.receipts.push(newReceipt);
            session.currentReceiptIndex = session.receipts.length - 1;
            
            if (isImage) {
                session.state = 'AWAITING_PARTICIPANTS';
                await reply(msg, `Found ${items.length} items for Bill ${session.receipts.length}! 🎉\n\nWho is sharing this bill? Send a comma-separated list of names (e.g., Alice, Bob, Charlie).`);
            } else {
                session.state = 'AWAITING_TAX';
                await reply(msg, `Found ${items.length} items for Bill ${session.receipts.length}! 🎉\n\nIs there any tax or service charge for this bill?\n\nReply with:\n- 'no' / '0' if no tax\n- 'yes' / 'included' if tax is already included in the prices\n- A percentage or amount (e.g. '10%' or '15k') to distribute it proportionally.`);
            }
        } 
        else if (session.state === 'AWAITING_TAX') {
            const receipt = session.receipts[session.currentReceiptIndex];
            const total = receipt.items.reduce((s, i) => s + i.price, 0);
            const tax = parseTaxInput(text);
            
            if (!tax) {
                await reply(msg, "Sorry, I couldn't understand that. Please reply with:\n- 'no' / '0' if no tax\n- 'yes' / 'included' if tax is already included\n- A percentage or amount (e.g. '10%' or '15k')");
                return;
            }
            
            if (tax.type === 'percent') {
                const multiplier = 1 + (tax.value / 100);
                receipt.items.forEach(item => {
                    item.price = Math.round(item.price * multiplier);
                });
                const newTotal = receipt.items.reduce((s, i) => s + i.price, 0);
                await reply(msg, `✅ Added ${tax.value}% tax/service charge. New total is Rp ${newTotal.toLocaleString('id-ID')}.`);
            } else if (tax.type === 'amount') {
                const taxAmt = tax.value;
                receipt.items.forEach(item => {
                    item.price = Math.round(item.price + (item.price / total) * taxAmt);
                });
                const newTotal = receipt.items.reduce((s, i) => s + i.price, 0);
                await reply(msg, `✅ Distributed Rp ${taxAmt.toLocaleString('id-ID')} tax/service charge proportionally. New total is Rp ${newTotal.toLocaleString('id-ID')}.`);
            } else if (tax.type === 'included' || tax.type === 'none') {
                await reply(msg, `✅ Total remains Rp ${total.toLocaleString('id-ID')}.`);
            }
            
            session.state = 'AWAITING_PARTICIPANTS';
            await reply(msg, `Who is sharing this bill? Send a comma-separated list of names (e.g., Alice, Bob, Charlie).`);
        }
        else if (session.state === 'AWAITING_PARTICIPANTS') {
            const receipt = session.receipts[session.currentReceiptIndex];
            receipt.participants = text.split(',').map(n => n.trim());
            session.currentItemIndex = 0;
            session.state = 'ASSIGNING_OWNERS';
            
            await askForOwners(msg, session, from);
        } 
        else if (session.state === 'ASSIGNING_OWNERS') {
            const receipt = session.receipts[session.currentReceiptIndex];
            const item = receipt.items[session.currentItemIndex];
            
            let validOwners = [];
            if (text.trim().toLowerCase() === 'all') {
                validOwners = [...receipt.participants];
            } else {
                const ownerIndexes = text.split(/[\s,]+/).map(n => parseInt(n.trim(), 10) - 1);
                ownerIndexes.forEach(idx => {
                    if (receipt.participants[idx]) validOwners.push(receipt.participants[idx]);
                });
            }
            
            if (validOwners.length === 0) {
                await reply(msg, `Please reply with valid numbers from the list (e.g. '1, 2') or type 'all'.`);
                return;
            }
            
            item.owners = validOwners;
            
            session.currentItemIndex++;
            if (session.currentItemIndex >= receipt.items.length) {
                session.state = 'AWAITING_MORE_RECEIPTS';
                await reply(msg, `All items for Bill ${session.receipts.length} have been assigned! 🧾\n\nDo you want to add another receipt to this split session?\n- Upload another photo of a receipt.\n- Type/paste another items list (e.g. "Badminton 163k").\n- Or reply 'no' / 'done' to proceed to payment.`);
            } else {
                await askForOwners(msg, session, from);
            }
        }
        else if (session.state === 'AWAITING_MORE_RECEIPTS') {
            if (text.toLowerCase() === 'no' || text.toLowerCase() === 'done') {
                session.state = 'AWAITING_PAYERS';
                session.currentReceiptPayerIndex = 0;
                
                const currentReceipt = session.receipts[0];
                const total = currentReceipt.items.reduce((s, i) => s + i.price, 0);
                let prompt = `*Payer Details Required* 🧾\n\n`;
                prompt += `Who paid for *Bill 1* (Total: Rp ${total.toLocaleString('id-ID')})?\n\n`;
                prompt += `Reply with:\n`;
                prompt += `- A participant number:\n`;
                currentReceipt.participants.forEach((p, idx) => {
                    prompt += `  ${idx + 1}. ${p}\n`;
                });
                prompt += `- Any other name not in the list (e.g. David)\n`;
                prompt += `- Multiple payers with amounts (e.g. Alice 100k, Bob 50k)\n`;
                prompt += `- Or type 'me' to default to you (${userName}).`;
                await reply(msg, prompt);
            } else {
                await reply(msg, "Please upload another photo, type/paste your items list, or reply 'no'/'done' to proceed to payment.");
            }
        }
        else if (session.state === 'AWAITING_PAYERS') {
            const currentReceipt = session.receipts[session.currentReceiptPayerIndex];
            const currentTotal = currentReceipt.items.reduce((s, i) => s + i.price, 0);
            
            const payers = parsePayers(text, currentReceipt.participants, currentTotal, userName);
            
            if (!payers || payers.length === 0) {
                await reply(msg, "Sorry, I couldn't understand that. Please specify who paid (e.g. '1' or 'Alice 100k, Bob 50k').");
                return;
            }
            
            currentReceipt.payers = payers;
            
            session.currentReceiptPayerIndex++;
            if (session.currentReceiptPayerIndex < session.receipts.length) {
                const nextReceipt = session.receipts[session.currentReceiptPayerIndex];
                const nextTotal = nextReceipt.items.reduce((s, i) => s + i.price, 0);
                
                let prompt = `Who paid for *Bill ${session.currentReceiptPayerIndex + 1}* (Total: Rp ${nextTotal.toLocaleString('id-ID')})?\n\n`;
                prompt += `Reply with:\n`;
                prompt += `- A participant number:\n`;
                nextReceipt.participants.forEach((p, idx) => {
                    prompt += `  ${idx + 1}. ${p}\n`;
                });
                prompt += `- Any other name not in the list (e.g. David)\n`;
                prompt += `- Multiple payers with amounts (e.g. Alice 100k, Bob 50k)\n`;
                prompt += `- Or type 'me' to default to you (${userName}).`;
                await reply(msg, prompt);
            } else {
                await calculateSplitBill(msg, session, userName, from);
            }
        }
    } catch (e) {
        console.error("Gemini/SplitBill Error:", e);
        await reply(msg, "Sorry, I couldn't process the request. Please type 'cancel' to exit, or try again.");
    }
}

const CAT_EMOJIS = { 
    'Food & Beverage': '🍔', 
    'Groceries': '🛒', 
    'Transportation': '🚗', 
    'Utilities': '⚡', 
    'Bills': '🧾',
    'Sport & Hobbies': '🏸',
    'Shopping': '🛍️', 
    'Health': '💊', 
    'Entertainment': '🎬', 
    'Investment & Savings': '📈',
    'Education': '📚',
    'Donation & Charity': '🤝',
    'Miscellaneous': '📦' 
};

const BPS_BENCHMARKS = {
    'Food & Beverage': 25,
    'Groceries': 20,
    'Transportation': 15,
    'Utilities': 10,
    'Bills': 10,
    'Shopping': 10,
    'Entertainment': 5,
    'Miscellaneous': 5
};

const LEAK_KEYWORDS = [
    'coffee', 'kopi', 'snacks', 'snack', 'camilan', 'jajan',
    'boba', 'parking', 'parkir', 'game', 'top up', 'topup',
    'cigarette', 'rokok', 'gojek', 'grab', 'ojek', 'matcha',
    'ice cream', 'es krim', 'biscuit', 'biskuit', 'candy', 'permen'
];

async function generateReportForUser(userName, timeframe) {
    if (!doc) await initGoogleSheets();
    const sheet = doc.sheetsByTitle[userName];
    if (!sheet) {
        return `📊 *Summary — ${timeframe.toUpperCase()}*\n━━━━━━━━━━━━━━━━━\n\nNo expenses logged yet! Use \`/log [amount] [description]\` to start tracking.`;
    }
    
    const rows = await sheet.getRows();
    const now = moment().utcOffset('+07:00');
    const dateStr = now.format('D MMM YYYY');
    
    let filterLabel = 'Today';
    let filterType = 'daily';
    
    const normalizedTimeframe = (timeframe || 'td').toLowerCase().trim();
    if (normalizedTimeframe === 'wtd' || normalizedTimeframe === 'week') {
        filterLabel = 'This Week';
        filterType = 'weekly';
    } else if (normalizedTimeframe === 'mtd' || normalizedTimeframe === 'month') {
        filterLabel = 'Month to Date';
        filterType = 'monthly';
    } else if (normalizedTimeframe === 'all') {
        filterLabel = 'All Time';
        filterType = 'all';
    }

    const mtdTransactions = [];
    const pmtdTransactions = [];
    const filteredTransactions = [];
    
    const prevMonthStart = now.clone().subtract(1, 'month').startOf('month');
    const prevMonthSameDayEnd = now.clone().subtract(1, 'month').endOf('day');
    
    const startOfWeek = now.clone().startOf('isoWeek');
    const endOfWeek = now.clone().endOf('isoWeek');
    
    rows.forEach(r => {
        const amt = parseFloat(r.get('Amount'));
        if (isNaN(amt)) return;
        
        const timestampStr = r.get('Timestamp');
        const rowDate = parseIdDate(timestampStr);
        if (!rowDate) return;
        
        const mDate = moment(rowDate);
        const desc = r.get('Description') || 'No description';
        const cat = r.get('Category') || 'Miscellaneous';
        
        const tx = { amt, desc, cat, date: mDate, timestamp: timestampStr };
        
        // MTD check
        if (mDate.isSame(now, 'month') && mDate.isSameOrBefore(now, 'day')) {
            mtdTransactions.push(tx);
        }
        
        // PMTD check
        if (mDate.isSame(prevMonthStart, 'month') && mDate.isSameOrBefore(prevMonthSameDayEnd, 'day')) {
            pmtdTransactions.push(tx);
        }
        
        // Filtered check (for the main list in the report)
        let matchesFilter = false;
        if (filterType === 'daily') {
            matchesFilter = mDate.isSame(now, 'day');
        } else if (filterType === 'weekly') {
            matchesFilter = mDate.isSame(now, 'isoWeek');
        } else if (filterType === 'monthly') {
            matchesFilter = mDate.isSame(now, 'month') && mDate.isSameOrBefore(now, 'day');
        } else if (filterType === 'all') {
            matchesFilter = true;
        }
        
        if (matchesFilter) {
            filteredTransactions.push(tx);
        }
    });

    if (filterType === 'daily') {
        const totalFiltered = filteredTransactions.reduce((sum, tx) => sum + tx.amt, 0);
        const txCount = filteredTransactions.length;
        
        const catData = {};
        filteredTransactions.forEach(tx => {
            if (!catData[tx.cat]) catData[tx.cat] = { total: 0, items: [] };
            catData[tx.cat].total += tx.amt;
            catData[tx.cat].items.push({ desc: tx.desc, amt: tx.amt });
        });

        const mtdTotal = mtdTransactions.reduce((sum, tx) => sum + tx.amt, 0);
        const currentDayNumber = now.date();
        const daysInMonth = now.daysInMonth();
        const burnRate = currentDayNumber > 0 ? (mtdTotal / currentDayNumber) : 0;
        const projectedEOM = burnRate * daysInMonth;

        const uniqueDaysWithTx = new Set(mtdTransactions.map(tx => tx.date.date()));
        const zeroSpendDays = currentDayNumber - uniqueDaysWithTx.size;

        let res = `📅 *Daily Finance Summary (${dateStr})*\n`;
        res += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        res += `💰 *Today's Total:* Rp ${totalFiltered.toLocaleString('id-ID')}\n`;
        res += `📝 *Today's Transactions:* ${txCount}\n\n`;
        
        if (txCount > 0) {
            res += `📂 *Today's Spend:*\n`;
            const sortedCats = Object.entries(catData).sort((a, b) => b[1].total - a[1].total);
            for (const [cat, data] of sortedCats) {
                const emoji = CAT_EMOJIS[cat] || '📦';
                const pct = Math.round((data.total / totalFiltered) * 100);
                res += `┌──────────────────\n`;
                res += `│ ${emoji} *${cat}*\n`;
                res += `│    Rp ${data.total.toLocaleString('id-ID')} (${pct}%)\n`;
                data.items.forEach(item => {
                    res += `│    • ${item.desc} — Rp ${item.amt.toLocaleString('id-ID')}\n`;
                });
                res += `└──────────────────\n`;
            }
            res += `\n`;
        } else {
            res += `✨ No expenses logged today!\n\n`;
        }
        
        res += `📊 *MTD Insights (Month-to-Date):*\n`;
        res += `• MTD Total: Rp ${mtdTotal.toLocaleString('id-ID')}\n`;
        res += `• Daily Burn Rate: Rp ${Math.round(burnRate).toLocaleString('id-ID')}/day\n`;
        res += `• Projected EOM: Rp ${Math.round(projectedEOM).toLocaleString('id-ID')}\n`;
        res += `• Zero-Spend Days: ${zeroSpendDays} days this month! 🎉\n`;
        res += `━━━━━━━━━━━━━━━━━━━━━━`;
        return res;
    }

    if (filterType === 'weekly') {
        const totalFiltered = filteredTransactions.reduce((sum, tx) => sum + tx.amt, 0);
        const txCount = filteredTransactions.length;
        
        const catData = {};
        filteredTransactions.forEach(tx => {
            if (!catData[tx.cat]) catData[tx.cat] = { total: 0, items: [] };
            catData[tx.cat].total += tx.amt;
            catData[tx.cat].items.push({ desc: tx.desc, amt: tx.amt });
        });

        const leakCounts = {};
        const leakSpend = {};
        filteredTransactions.forEach(tx => {
            const descLower = tx.desc.toLowerCase();
            LEAK_KEYWORDS.forEach(kw => {
                if (descLower.includes(kw)) {
                    leakCounts[kw] = (leakCounts[kw] || 0) + 1;
                    leakSpend[kw] = (leakSpend[kw] || 0) + tx.amt;
                }
            });
        });

        const leaks = Object.entries(leakCounts)
            .filter(([kw, count]) => count >= 3)
            .map(([kw, count]) => ({ kw, count, total: leakSpend[kw] }));

        const daySpends = {};
        filteredTransactions.forEach(tx => {
            const dayName = tx.date.format('dddd');
            daySpends[dayName] = (daySpends[dayName] || 0) + tx.amt;
        });
        
        let maxDayName = 'N/A';
        let maxDayAmt = 0;
        for (const [day, amt] of Object.entries(daySpends)) {
            if (amt > maxDayAmt) {
                maxDayAmt = amt;
                maxDayName = day;
            }
        }

        const periodStr = `${startOfWeek.format('D MMM')} - ${endOfWeek.format('D MMM YYYY')}`;
        let res = `📅 *Weekly Finance Summary (WTD)*\n`;
        res += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        res += `📅 *Period:* ${periodStr}\n`;
        res += `💰 *Total WTD Spend:* Rp ${totalFiltered.toLocaleString('id-ID')}\n`;
        res += `📝 *Transactions:* ${txCount}\n\n`;
        
        if (txCount > 0) {
            res += `📂 *By Category:*\n`;
            const sortedCats = Object.entries(catData).sort((a, b) => b[1].total - a[1].total);
            for (const [cat, data] of sortedCats) {
                const emoji = CAT_EMOJIS[cat] || '📦';
                const pct = Math.round((data.total / totalFiltered) * 100);
                res += `┌──────────────────\n`;
                res += `│ ${emoji} *${cat}*\n`;
                res += `│    Rp ${data.total.toLocaleString('id-ID')} (${pct}%)\n`;
                data.items.forEach(item => {
                    res += `│    • ${item.desc} — Rp ${item.amt.toLocaleString('id-ID')}\n`;
                });
                res += `└──────────────────\n`;
            }
            res += `\n`;
        } else {
            res += `✨ No expenses logged this week!\n\n`;
        }
        
        res += `🔍 *Weekly Profiler Insights:*\n`;
        res += `• 🏆 *Highest Spend Day:* ${maxDayName} ${maxDayAmt > 0 ? `(Rp ${maxDayAmt.toLocaleString('id-ID')})` : ''}\n`;
        
        if (leaks.length > 0) {
            res += `• ⚠️ *Micro-Leak Alerts (Freq ≥ 3):*\n`;
            leaks.forEach(lk => {
                res += `  - *${lk.kw}* (${lk.count}x): Rp ${lk.total.toLocaleString('id-ID')}\n`;
            });
            res += `  _(Tip: Try budgeting these minor recurring costs!)_\n`;
        } else {
            res += `• 🛡️ *Micro-Leaks:* No leaks detected this week. Great job!\n`;
        }
        res += `━━━━━━━━━━━━━━━━━━━━━━`;
        return res;
    }

    if (filterType === 'monthly') {
        const mtdTotal = mtdTransactions.reduce((sum, tx) => sum + tx.amt, 0);
        const pmtdTotal = pmtdTransactions.reduce((sum, tx) => sum + tx.amt, 0);
        const isFirstMonth = pmtdTotal === 0;
        
        const mtdCatTotals = {};
        const mtdCatData = {};
        mtdTransactions.forEach(tx => {
            mtdCatTotals[tx.cat] = (mtdCatTotals[tx.cat] || 0) + tx.amt;
            if (!mtdCatData[tx.cat]) mtdCatData[tx.cat] = { total: 0, items: [] };
            mtdCatData[tx.cat].total += tx.amt;
            mtdCatData[tx.cat].items.push({ desc: tx.desc, amt: tx.amt });
        });
        
        const pmtdCatTotals = {};
        pmtdTransactions.forEach(tx => {
            pmtdCatTotals[tx.cat] = (pmtdCatTotals[tx.cat] || 0) + tx.amt;
        });

        const momAlerts = [];
        if (!isFirstMonth) {
            for (const [cat, mtdAmt] of Object.entries(mtdCatTotals)) {
                const pmtdAmt = pmtdCatTotals[cat] || 0;
                if (pmtdAmt > 0) {
                    const pctIncrease = ((mtdAmt - pmtdAmt) / pmtdAmt) * 100;
                    if (pctIncrease > 20) {
                        momAlerts.push({
                            cat,
                            mtdAmt,
                            pmtdAmt,
                            pct: Math.round(pctIncrease)
                        });
                    }
                } else {
                    momAlerts.push({
                        cat,
                        mtdAmt,
                        pmtdAmt: 0,
                        pct: 100
                    });
                }
            }
        }

        const benchmarkAlerts = [];
        for (const [cat, mtdAmt] of Object.entries(mtdCatTotals)) {
            const pctOfTotal = mtdTotal > 0 ? ((mtdAmt / mtdTotal) * 100) : 0;
            const benchmarkPct = BPS_BENCHMARKS[cat] || 5;
            if (pctOfTotal > (benchmarkPct + 5)) {
                benchmarkAlerts.push({
                    cat,
                    pct: Math.round(pctOfTotal),
                    benchmark: benchmarkPct,
                    over: Math.round(pctOfTotal - benchmarkPct)
                });
            }
        }

        const outliers = [...mtdTransactions]
            .sort((a, b) => b.amt - a.amt)
            .slice(0, 3);

        const monthName = now.format('MMMM YYYY');
        let res = `📅 *Monthly Finance Summary (MTD)*\n`;
        res += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        res += `📅 *Month:* ${monthName}\n`;
        res += `💰 *Total MTD Spend:* Rp ${mtdTotal.toLocaleString('id-ID')}\n`;
        if (!isFirstMonth) {
            res += `📊 *vs PMTD Same-Period:* Rp ${pmtdTotal.toLocaleString('id-ID')}\n`;
        }
        res += `📝 *Transactions:* ${mtdTransactions.length}\n\n`;
        
        if (mtdTransactions.length > 0) {
            res += `📂 *By Category MTD:*\n`;
            const sortedCats = Object.entries(mtdCatData).sort((a, b) => b[1].total - a[1].total);
            for (const [cat, data] of sortedCats) {
                const emoji = CAT_EMOJIS[cat] || '📦';
                const pct = Math.round((data.total / mtdTotal) * 100);
                res += `┌──────────────────\n`;
                res += `│ ${emoji} *${cat}*\n`;
                res += `│    Rp ${data.total.toLocaleString('id-ID')} (${pct}%)\n`;
                data.items.forEach(item => {
                    res += `│    • ${item.desc} — Rp ${item.amt.toLocaleString('id-ID')}\n`;
                });
                res += `└──────────────────\n`;
            }
            res += `\n`;
        } else {
            res += `✨ No expenses logged this month!\n\n`;
        }
        
        res += `📊 *Monthly Alerts & Insights:*\n`;
        
        if (isFirstMonth) {
            res += `• 🌱 *Welcome:* This is your first month tracking. We will show Month-over-Month comparisons starting next month!\n`;
        } else {
            if (momAlerts.length > 0) {
                res += `• 🚨 *MoM Spend Increase (>20%):*\n`;
                momAlerts.forEach(al => {
                    if (al.pmtdAmt > 0) {
                        res += `  - *${al.cat}:* Rp ${al.mtdAmt.toLocaleString('id-ID')} (+${al.pct}% vs last month's Rp ${al.pmtdAmt.toLocaleString('id-ID')})\n`;
                    } else {
                        res += `  - *${al.cat}:* Rp ${al.mtdAmt.toLocaleString('id-ID')} (New category spend this month!)\n`;
                    }
                });
            } else {
                res += `• MoM Spend: No categories had a significant spend increase. Excellent discipline!\n`;
            }
        }
        
        if (benchmarkAlerts.length > 0) {
            res += `• 📊 *Budget Overage Alerts (>5% Over):*\n`;
            benchmarkAlerts.forEach(al => {
                res += `  - *${al.cat}:* ${al.pct}% of total spend (Benchmark: ${al.benchmark}% — Over by ${al.over}%)\n`;
            });
        }
        
        if (outliers.length > 0) {
            res += `• 💸 *Top 3 Outlier Transactions:*\n`;
            outliers.forEach((out, idx) => {
                res += `  ${idx + 1}. Rp ${out.amt.toLocaleString('id-ID')} — ${out.desc} (${CAT_EMOJIS[out.cat] || ''} ${out.cat})\n`;
            });
        }
        res += `━━━━━━━━━━━━━━━━━━━━━━`;
        return res;
    }

    if (filterType === 'all') {
        const totalFiltered = filteredTransactions.reduce((sum, tx) => sum + tx.amt, 0);
        const txCount = filteredTransactions.length;
        
        const catData = {};
        filteredTransactions.forEach(tx => {
            if (!catData[tx.cat]) catData[tx.cat] = { total: 0, items: [] };
            catData[tx.cat].total += tx.amt;
            catData[tx.cat].items.push({ desc: tx.desc, amt: tx.amt });
        });
        
        let res = `📊 *Summary — All Time (${dateStr})*\n`;
        res += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        res += `💰 *Total: Rp ${totalFiltered.toLocaleString('id-ID')}*\n`;
        res += `📝 *Transactions: ${txCount}*\n\n`;
        res += `📂 *By Category:*\n`;
        
        const sorted = Object.entries(catData).sort((a, b) => b[1].total - a[1].total);
        for (const [cat, data] of sorted) {
            const emoji = CAT_EMOJIS[cat] || '📦';
            const pct = Math.round((data.total / totalFiltered) * 100);
            res += `┌──────────────────\n`;
            res += `│ ${emoji} *${cat}*\n`;
            res += `│    Rp ${data.total.toLocaleString('id-ID')} (${pct}%)\n`;
            data.items.forEach(item => {
                res += `│    • ${item.desc} — Rp ${item.amt.toLocaleString('id-ID')}\n`;
            });
            res += `└──────────────────\n`;
        }
        res += `━━━━━━━━━━━━━━━━━━━━━━`;
        return res;
    }
}

async function getReportUsers() {
    if (!doc) {
        await initGoogleSheets();
    }
    const users = [];
    if (ADMIN_NUMBER) {
        users.push({ phone: ADMIN_NUMBER, name: 'Admin' });
    }
    if (doc) {
        const sheet = doc.sheetsByTitle['AuthorizedUsers'];
        if (sheet) {
            const rows = await sheet.getRows();
            rows.forEach(r => {
                const phone = (r.get('Phone') || '').trim();
                const name = (r.get('Name') || '').trim();
                if (phone && name) {
                    if (!users.some(u => u.phone === phone)) {
                        users.push({ phone, name });
                    }
                }
            });
        }
    }
    return users;
}

async function sendScheduledReport(phone, name, type) {
    try {
        if (!sock) {
            console.log(`[Scheduler] WhatsApp socket is not initialized yet. Skipping scheduled report for ${name}.`);
            return;
        }
        const jid = phone.replace('@c.us', '@s.whatsapp.net');
        console.log(`[Scheduler] Generating ${type} report for ${name} (${jid})...`);
        const report = await generateReportForUser(name, type);
        if (report) {
            await sock.sendMessage(jid, { text: report });
            console.log(`[Scheduler] Report sent successfully to ${name}`);
        } else {
            console.log(`[Scheduler] No report generated/needed for ${name}`);
        }
    } catch (err) {
        console.error(`[Scheduler] Failed to send report to ${name} (${phone}):`, err);
    }
}

async function runWeeklyScheduler() {
    console.log('[Scheduler] Starting Weekly Summary push...');
    try {
        const users = await getReportUsers();
        for (const user of users) {
            await sendScheduledReport(user.phone, user.name, 'wtd');
        }
    } catch (err) {
        console.error('[Scheduler] Error in weekly scheduler:', err);
    }
}

async function runMonthlyScheduler() {
    const now = moment().utcOffset('+07:00');
    const isEOM = now.date() === now.daysInMonth();
    if (!isEOM) {
        console.log('[Scheduler] Today is not End of Month. Skipping monthly report push.');
        return;
    }
    
    console.log('[Scheduler] Starting Monthly End-of-Month Summary push...');
    try {
        const users = await getReportUsers();
        for (const user of users) {
            await sendScheduledReport(user.phone, user.name, 'mtd');
        }
    } catch (err) {
        console.error('[Scheduler] Error in monthly scheduler:', err);
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
        const altFrom = msg.key.remoteJidAlt ? msg.key.remoteJidAlt.replace('@s.whatsapp.net', '@c.us') : null;
        const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
        const text = rawText.trim().toLowerCase();

        const isAdmin = (from === ADMIN_NUMBER) || (altFrom && altFrom === ADMIN_NUMBER);

        console.log("\n======================================");
        console.log("DEBUG: INCOMING MESSAGE RECEIVED");
        console.log("-> msg.key:", JSON.stringify(msg.key));
        console.log("-> from (converted):", from);
        if (altFrom) console.log("-> altFrom (converted):", altFrom);
        console.log("-> ADMIN_NUMBER:", ADMIN_NUMBER);
        console.log("-> Exact match (primary/alt)?:", isAdmin);
        console.log("-> rawText:", rawText);
        console.log("======================================\n");
        
        try {
            if (!doc) await initGoogleSheets();
            
            let userName = await isUserAuthorized(from);
            if (!userName && altFrom) {
                userName = await isUserAuthorized(altFrom);
            }
            
            if (!userName) {
                await reply(msg, `⛔ Unauthorized. Please ask the Admin to add your number or JID.\n\nYour details:\n- Phone/JID: ${altFrom || from}`);
                return;
            }

            if (sessions[from]) {
                if (sessions[from].step === 'AWAITING_LOCATION') {
                    const isLocation = !!msg.message?.locationMessage;
                    if (!isLocation) {
                        await reply(msg, "⛔ Please send a valid WhatsApp Location pin using the attachment button (+ or 📎).");
                        return;
                    }

                    const lat = msg.message.locationMessage.degreesLatitude;
                    const lng = msg.message.locationMessage.degreesLongitude;
                    const query = sessions[from].query;
                    
                    await reply(msg, `⏳ Searching for the best ${query} nearby...`);
                    
                    try {
                        const url = `https://serpapi.com/search.json?engine=google_maps&q=${encodeURIComponent(query)}&type=search&ll=@${lat},${lng},15z&api_key=${process.env.SERPAPI_KEY}`;
                        
                        const response = await fetch(url);
                        const data = await response.json();
                        
                        if (!data.local_results || data.local_results.length === 0) {
                            await reply(msg, "😔 I couldn't find any good matches near your location.");
                            delete sessions[from];
                            return;
                        }

                        const topResults = data.local_results.slice(0, 3);
                        let replyString = `📍 *Top 3 ${query.toUpperCase()} nearby:*\n\n`;
                        
                        topResults.forEach((place, index) => {
                            const name = place.title || 'Unknown Place';
                            const rating = place.rating ? `⭐ ${place.rating} (${place.reviews} reviews)` : 'No rating';
                            
                            const description = place.description || place.snippet || '';
                            const commentStr = description ? `\n💬 "${description}"` : '';
                            
                            const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
                            const tiktokLink = `https://www.tiktok.com/search?q=${encodeURIComponent(name)}`;
                            const igLink = `https://www.instagram.com/explore/tags/${name.replace(/\s+/g, '').toLowerCase()}/`;
                            
                            replyString += `*${index + 1}. ${name}*\n${rating}${commentStr}\n🗺️ GMaps: ${mapsLink}\n📱 Check Vibes: [TikTok](${tiktokLink}) | [Instagram](${igLink})\n\n`;
                        });

                        await reply(msg, replyString.trim());
                        delete sessions[from];
                        return;
                        
                    } catch (error) {
                        console.error('SerpApi Error:', error);
                        await reply(msg, "⚠️ Sorry, the search engine encountered an error. Please try again later.");
                        delete sessions[from];
                        return;
                    }
                } else {
                    await handleSplitBill(msg, userName, from, rawText.trim());
                    return;
                }
            }

            const helpKeywords = ['hi', 'hello', 'help', 'halo', 'p', '/help'];
            if (helpKeywords.includes(text)) {
                let helpText = "Hello! 👋 I am your personal *Lifestyle Assistant*! 🌟\n\nHere is how I can help make your day easier:\n\n💸 *Money Management*\n• `/log [amount] for [item]` - Log a daily expense.\n• `/summary today` or `/summary mtd` - View your financial analytics.\n• `/splitbill` - Calculate shared bills with friends.\n\n📍 *Local Concierge*\n• `/find [place]` - Find the best spots near your current location (e.g., '/find coffee').";
                
                if (isAdmin) {
                    helpText += "\n\n👑 *Admin Settings*\n• `/adduser [number] [name]` - Add a new user.";
                }
                
                await reply(msg, helpText);
                return;
            }

            if (!rawText.startsWith('/')) return;

            const rawArgs = rawText.split(' ');
            const command = rawArgs[0].toLowerCase();
            const argsText = rawArgs.slice(1).join(' ').trim();

            if (command === '/adduser') {
                if (!isAdmin) {
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
                        'gofood', 'grabfood', 'shopeefood', 'mcd', 'kfc', 'starbucks', 'chatime',
                        'warung', 'food', 'eat', 'lunch', 'dinner', 'breakfast', 'brunch', 'snack',
                        'coffee', 'tea', 'juice', 'milk', 'bread', 'cake', 'pizza', 'burger',
                        'rice', 'noodle', 'pasta', 'chicken', 'beef', 'fish', 'salad',
                        'restaurant', 'cafe', 'bistro', 'dine', 'meal', 'dessert', 'ice cream',
                        'boba', 'matcha', 'latte', 'espresso', 'americano', 'croissant',
                        'sandwich', 'wrap', 'sushi', 'ramen', 'donut', 'waffle', 'pancake',
                        'salt', 'chocolate', 'cookie', 'pastry', 'fries', 'padang',
                        'gacoan', 'solaria', 'richeese', 'baba rafi', 'jco', 'j.co', 'bakmi gm',
                        'cfc', 'marugame', 'udon', 'yoshinoya', 'sushi tei', 'kopi kenangan',
                        'janji jiwa', 'fore coffee', 'excelso', 'mixue', 'tealive', 'dum dum',
                        'koi the', 'koi thé', 'shaburi', 'kintan', 'holy cow', 'holycow',
                        'burger king', 'bk', 'pizza hut', 'ph', 'dominos', 'domino\'s',
                        'aw restaurant', 'a&w', 'mako cake', 'breadtalk', 'tous les jours',
                        'harvest cake', 'sour sally', 'kebab', 'warmindo', 'angkringan',
                        'pecel lele', 'soto betawi', 'martabak pecennongan', 'kopi nako',
                        'kopimana', 'ta wan', 'tawan', 'imperial kitchen', 'dimsum',
                        'd\'cost', 'dcost', 'hokben', 'hoka hoka bento', 'pepper lunch',
                        'sushi go', 'sushigo', 'genki sushi', 'gindaco', 'rejuve', 're.juve',
                        'boost juice', 'kopi toko djawa', 'anomali'
                    ],
                    'Groceries': [
                        'supermarket', 'indomaret', 'alfamart', 'hypermart', 'aeon',
                        'sayur', 'buah', 'bumbu', 'sabun', 'shampo', 'tissue',
                        'grocery', 'market', 'store', 'mart', 'vegetable', 'fruit',
                        'alfamidi', 'midi', 'superindo', 'super indo', 'carrefour', 'transmart',
                        'giant', 'hero supermarket', 'lotte mart', 'lottemart', 'lotte grosir',
                        'farmers market', 'ranch market', 'the foodhall', 'foodhall',
                        'grand lucky', 'grandlucky', 'sayurbox', 'tanihub', 'kebut',
                        'papaya fresh', 'toko kelontong', 'pasar', 'sembako', 'beras',
                        'minyak goreng', 'telur', 'gula', 'garam', 'deterjen', 'pewangi',
                        'pasta gigi', 'odol', 'sikat gigi', 'shampoo'
                    ],
                    'Transportation': [
                        'bensin', 'grab', 'gojek', 'tol', 'parkir', 'pertamax',
                        'taxi', 'uber', 'gas', 'fuel', 'train', 'bus', 'mrt',
                        'ojek', 'transjakarta', 'commuter', 'travel', 'toll',
                        'gocar', 'goride', 'grabcar', 'grabbike', 'maxim', 'indrive',
                        'lrt', 'krl', 'commuterline', 'kereta', 'kai', 'damri',
                        'pertalite', 'pertamax turbo', 'dexlite', 'pertamina dex',
                        'pertamina', 'shell', 'shell super', 'v-power', 'bp fuel',
                        'bp-akr', 'emoney', 'e-money', 'flazz', 'brizzi', 'tapcash',
                        'e-toll', 'etoll', 'linkaja', 'ovo', 'dana', 'gopay',
                        'astrapay', 'bluebird', 'blue bird', 'garuda', 'citilink',
                        'lion air', 'batik air', 'sriwijaya', 'airasia', 'traveloka',
                        'tiket.com', 'kai access', 'go-ride', 'go-car'
                    ],
                    'Utilities': [
                        'listrik', 'token', 'internet', 'pulsa', 'air', 'pdam',
                        'electric', 'water', 'phone', 'wifi', 'bill', 'subscription',
                        'pln', 'telkomsel', 'indosat', 'im3', 'xl', 'tri', '3',
                        'smartfren', 'axis', 'byu', 'by.u', 'indihome', 'first media',
                        'firstmedia', 'biznet', 'myrepublic', 'cbn', 'mnc play', 'telkom',
                        'pascabayar', 'postpaid', 'prabayar', 'prepaid', 'gas alam', 'pgn'
                    ],
                    'Bills': [
                        'tagihan', 'bpjs', 'asuransi', 'pajak', 'tax', 'sewa', 'kost', 'kos',
                        'rent', 'kontrakan', 'subscription', 'langganan', 'credit card', 'cc',
                        'pinjol', 'cicilan', 'leasing'
                    ],
                    'Sport & Hobbies': [
                        'badminton', 'futsal', 'gym', 'court', 'sewa lapangan', 'racket', 'raket',
                        'tenis', 'tennis', 'running', 'lari', 'gowes', 'sepeda', 'renang',
                        'swimming', 'fitness', 'yoga', 'pilates', 'golf', 'climbing', 'hiking',
                        'ticket', 'tiket konser', 'event'
                    ],
                    'Shopping': [
                        'baju', 'celana', 'sepatu', 'tas', 'jam', 'aksesori',
                        'clothes', 'shoes', 'bag', 'watch', 'shirt', 'pants',
                        'dress', 'fashion', 'shopee', 'tokopedia', 'lazada',
                        'tokped', 'blibli', 'bukalapak', 'tiktok shop', 'tiktokshop',
                        'uniqlo', 'zara', 'h&m', 'pull&bear', 'pull and bear', 'adidas',
                        'nike', 'puma', 'decathlon', 'map club', 'sogo', 'metro',
                        'seibu', 'central dept', 'galeries lafayette', 'sarinah',
                        'matahari', 'ramayana', 'miniso', 'kkv', 'sociolla',
                        'ikea', 'informa', 'ace hardware', 'ace', 'hardware',
                        'guardian', 'watsons', 'watson', 'century', 'shopee mall'
                    ],
                    'Health': [
                        'obat', 'dokter', 'rumah sakit', 'apotek', 'vitamin',
                        'medicine', 'doctor', 'hospital', 'pharmacy', 'clinic', 'gym',
                        'kimia farma', 'k24', 'k-24', 'roxy', 'viva health', 'halodoc',
                        'alodokter', 'bpjs kesehatan', 'celebrity fitness', 'celfit',
                        'fitness first', 'golds gym', 'gold\'s gym', 'fithub', 'fit hub',
                        'megaclinic', 'prodia', 'lab', 'laboratorium', 'klinik', 'puskesmas',
                        'suplemen', 'masker', 'hand sanitizer'
                    ],
                    'Entertainment': [
                        'bioskop', 'film', 'game', 'netflix', 'spotify', 'youtube',
                        'movie', 'cinema', 'concert', 'ticket', 'karaoke',
                        'xxi', 'cgv', 'cinepolis', 'disney+', 'hotstar', 'hbo',
                        'prime video', 'viu', 'iqiyi', 'wetv', 'vidio', 'steam',
                        'playstation', 'nintendo', 'roblox', 'mobile legends', 'mlbb',
                        'pubg', 'genshin', 'valheim', 'minecraft', 'top up game',
                        'timezone', 'dufan', 'ancol', 'taman safari', 'klook',
                        'konser', 'tiket konser', 'karaoke family'
                    ],
                    'Investment & Savings': [
                        'reksadana', 'saham', 'emas', 'crypto', 'bitcoin', 'tabungan',
                        'invest', 'bibit', 'bareksa', 'ajaib', 'binance', 'tokocrypto',
                        'depo', 'deposito'
                    ],
                    'Education': [
                        'buku', 'kursus', 'spp', 'kuliah', 'sekolah', 'course', 'udemy',
                        'coursera', 'bootcamp', 'seminar', 'training', 'biaya sekolah',
                        'lks', 'ujian'
                    ],
                    'Donation & Charity': [
                        'zakat', 'sedekah', 'infak', 'sumbangan', 'perpuluhan', 'tithe',
                        'donasi', 'charity', 'tips', 'tip', 'parkir liar'
                    ]
                };
                let category = 'Miscellaneous';
                const searchText = argsText.toLowerCase();
                for (const [cat, keys] of Object.entries(CATEGORIES)) {
                    if (keys.some(k => searchText.includes(k))) {
                        category = cat; break;
                    }
                }

                await logUserExpense(userName, amount, description, category, customDate);
                const catEmojis = { 
                    'Food & Beverage': '🍔', 
                    'Groceries': '🛒', 
                    'Transportation': '🚗', 
                    'Utilities': '⚡', 
                    'Bills': '🧾',
                    'Sport & Hobbies': '🏸',
                    'Shopping': '🛍️', 
                    'Health': '💊', 
                    'Entertainment': '🎬', 
                    'Investment & Savings': '📈',
                    'Education': '📚',
                    'Donation & Charity': '🤝',
                    'Miscellaneous': '📦' 
                };
                await reply(msg, `✅ *Recorded!*\n\n📝 ${description}\n${catEmojis[category] || '📦'} ${category}\n💰 Rp ${amount.toLocaleString('id-ID')}\n📅 ${customDate || 'Today'}`);
            }
            else if (command === '/summary') {
                try {
                    const timeframe = argsText || 'td';
                    const report = await generateReportForUser(userName, timeframe);
                    await reply(msg, report);
                } catch (err) {
                    console.error("Error generating summary:", err);
                    await reply(msg, "❌ Failed to generate summary: " + err.message);
                }
            }
            else if (command === '/splitbill' || command === '/spltbill' || command === '/sb') {
                sessions[from] = { state: 'AWAITING_RECEIPT' };
                if (argsText) {
                    await handleSplitBill(msg, userName, from, argsText);
                } else {
                    await reply(msg, "Alright! 🧾 Please send me a photo of the receipt. If you don't have a photo, you can type/paste your items list directly instead (e.g., \"Badminton 163k\" or \"Pizza 100k, Coke 20k\").");
                }
            }
            else if (command === '/find') {
                if (!argsText) {
                    await reply(msg, "🔍 Please specify what you want to find (e.g. `/find coffee` or `/find restaurants`).");
                    return;
                }
                sessions[from] = { step: 'AWAITING_LOCATION', query: argsText };
                await reply(msg, "📍 Please send me your current Location Pin (attachment 📎 -> Location) so I can search nearby spots for you.");
            }
        } catch (e) {
            console.error(e);
            await reply(msg, "❌ Error: " + e.message);
        }
    });
}

startWhatsAppBot();

// Schedule Weekly WTD report (every Sunday at 20:00 Asia/Jakarta time)
cron.schedule('0 20 * * 0', async () => {
    await runWeeklyScheduler();
}, {
    scheduled: true,
    timezone: "Asia/Jakarta"
});

// Schedule Monthly MTD report (daily check at 20:00 Asia/Jakarta time)
cron.schedule('0 20 * * *', async () => {
    await runMonthlyScheduler();
}, {
    scheduled: true,
    timezone: "Asia/Jakarta"
});
