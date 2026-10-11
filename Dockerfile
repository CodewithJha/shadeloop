# Single image: API + built PWA. The server runs TypeScript directly via Node's type stripping (Node >= 23.6).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev && npm cache clean --force
COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8080
CMD ["node", "server/src/index.ts"]
