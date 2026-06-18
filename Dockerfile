FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    ca-certificates \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Set Environment variables
ENV TZ=Asia/Jakarta

WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install

# Copy source code
COPY . .

CMD ["node", "index.js"]
