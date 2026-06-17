# 用官方 Playwright image：已含 Chromium + 系統相依
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# 補中文字型，避免截圖中文變方框
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "dist/server.js"]
