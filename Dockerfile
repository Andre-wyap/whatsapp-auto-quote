FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install deps first so this layer only rebuilds when package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY documents ./documents

# Runs as the image's built-in unprivileged user rather than root.
USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
