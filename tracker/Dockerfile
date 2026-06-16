FROM oven/bun:1
WORKDIR /app
COPY package.json ./
RUN bun install --frozen-lockfile || bun install
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3011
CMD ["bun", "run", "src/index.ts", "watch"]
