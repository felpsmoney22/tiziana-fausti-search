# Imagem oficial do Playwright: já vem com Chromium + todas as libs do sistema.
# (self-consistente: a versão do browser bate com a do pacote playwright)
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Instala dependências primeiro (melhor cache de build)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o código
COPY . .

ENV NODE_ENV=production
# O Railway injeta a porta em $PORT; o server.js já lê ela.
EXPOSE 3000

CMD ["node", "server.js"]
