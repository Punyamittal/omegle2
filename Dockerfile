# 1. Build Frontend
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY package*.json ./
RUN npm install
COPY . .
# Set CI to true to avoid treating warnings as errors in some environments
ENV CI=false
RUN npm run build

# 2. Build Backend
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend
COPY server/package*.json ./
COPY server/tsconfig.json ./
RUN npm install
COPY server/ ./
RUN npm run build

# 3. Final Production Stage
FROM node:20-alpine
WORKDIR /app

# Copy backend dependencies
COPY server/package*.json ./
RUN npm install --only=production

# Copy built backend and frontend
COPY --from=backend-builder /app/backend/dist ./server/dist
COPY --from=frontend-builder /app/frontend/build ./build

# Environment variables for Hugging Face
ENV PORT=7860
ENV NODE_ENV=production
ENV JWT_SECRET=artillery-test-secret-change-me

EXPOSE 7860

# We need to run the server from the root to match the paths in index.ts
CMD ["node", "server/dist/index.js"]
