FROM node:20-slim

# Install system dependencies for headless Chromium
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

# Set Environment variables
ENV TZ=Asia/Jakarta
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy source code
COPY . .

CMD ["node", "index.js"]
