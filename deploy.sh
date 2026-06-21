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
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/docker \
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
echo "[Phase 3] Downloading latest application files from GitHub..."

# Download all necessary files from GitHub
curl -sSL https://raw.githubusercontent.com/albertusro1/SpendTrackerWA/main/package.json -o package.json
curl -sSL https://raw.githubusercontent.com/albertusro1/SpendTrackerWA/main/Dockerfile -o Dockerfile
curl -sSL https://raw.githubusercontent.com/albertusro1/SpendTrackerWA/main/docker-compose.yml -o docker-compose.yml
curl -sSL https://raw.githubusercontent.com/albertusro1/SpendTrackerWA/main/index.js -o index.js
curl -sSL https://raw.githubusercontent.com/albertusro1/SpendTrackerWA/main/.dockerignore -o .dockerignore

# Generate .env template if it doesn't exist
if [ ! -f .env ]; then
  cat << 'EOF' > .env
SPREADSHEET_ID=your_spreadsheet_id_placeholder
ADMIN_NUMBER=6281234567890@c.us
GEMINI_API_KEY=your_gemini_api_key_placeholder
OPENROUTER_API_KEY=your_openrouter_api_key_placeholder
SERPAPI_KEY=your_serpapi_key_placeholder
EOF
fi

echo "[Phase 3] Application files downloaded successfully."

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
echo "   (Ensure your service account key file is named credentials.json)"
echo ""
echo "3. Update your Environment Configurations:"
echo "   nano .env"
echo "   (Fill in your SPREADSHEET_ID, ADMIN_NUMBER, and API keys)"
echo ""
echo "4. Build the Docker infrastructure and start the bot in detached mode:"
echo "   docker compose up --build -d"
echo ""
echo "5. Scan the QR code using your WhatsApp Business account:"
echo "   docker compose logs -f wa-finance-bot"
echo "==================================================="
