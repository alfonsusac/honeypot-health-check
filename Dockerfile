FROM oven/bun:1 AS runtime

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun src ./src
RUN mkdir -p /app/cache && chown -R bun:bun /app

ENV NODE_ENV=production
EXPOSE 3000

USER bun
CMD ["bun", "run", "src/index.ts"]