# WhatsApp Personal Finance Bot

A Node.js bot using `whatsapp-web.js` to automatically parse expense logs from WhatsApp messages and record them to a Google Sheet. It's fully dockerized for easy deployment to VPS servers, using a headless Chromium instance.

## Setup Instructions

1. **Google Service Account**:
   - Create a Service Account in the Google Cloud Console.
   - Give it Editor access to the specific Google Sheet.
   - Download the JSON credentials file and rename it to `spend-tracker-apis-2f1df66442d0.json` in the root of this project.

2. **Google Sheet Setup**:
   - Ensure you have a Google Sheet with the ID specified in `docker-compose.yml`.
   - The first sheet (`sheetsByIndex[0]`) must have the following headers in the first row: `Timestamp`, `Description`, `Amount`, `Category`.

3. **Configure Environment Variables**:
   - Open `docker-compose.yml` and adjust `SPREADSHEET_ID` to match your Google Sheet ID.
   - Adjust `ALLOWED_SENDER` to your WhatsApp number (e.g., `6281234567890@c.us`) to enforce security.

4. **Running the Bot**:
   ```bash
   docker-compose up --build
   ```

5. **Authentication**:
   - On the first run, the bot will display a QR code in the terminal logs.
   - Scan it with your WhatsApp mobile app (Linked Devices) to authenticate.
   - The session will be saved in `./auth_session` to avoid re-authentication.

## Usage

Send a message like: `makan nasi goreng 25k` to the bot. 
The bot will parse it as:
- Description: `nasi goreng`
- Amount: `25000`
- Category: `Food & Beverage`

It will then append this data to the Google Sheet and reply with a confirmation.
