FROM oven/bun:1.3.8 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile 2>/dev/null || bun install --production

# Copy source
COPY . .

ENV PORT=3100
EXPOSE 3100

CMD ["bun", "run", "serve:http"]
