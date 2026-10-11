# Single image: API + built PWA. The server runs TypeScript directly via Node's type stripping (Node >= 23.6).
FROM node:24-alpine AS build
WORKDIR /app
# No tests run here, so skip mongodb-memory-server's mongod download (a dev dependency).
ENV MONGOMS_DISABLE_POSTINSTALL=1
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
# Server production dependencies only. The PWA is served as built files, so its runtime packages (react, idb) aren't needed.
RUN npm ci --omit=dev --workspace=server && npm cache clean --force
COPY shared/src shared/src
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "./server/src/instrument.ts", "server/src/index.ts"]
