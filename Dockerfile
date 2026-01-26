# Stage 1: Production Dependencies
FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Stage 2: All Dependencies (including dev for nodemon)
FROM node:20-slim AS deps-dev
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 3: Build with Prisma (for development)
FROM node:20-slim AS builder
WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update && apt-get install -y openssl --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps-dev /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate

# Stage 4: Production Builder (with production deps only)
FROM node:20-slim AS builder-prod
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate

# Stage 5: Production
FROM node:20-slim
WORKDIR /app

# Puppeteer dependencies (Chrome headless)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=builder-prod /app .
EXPOSE 8080
CMD ["node", "server.js"]
