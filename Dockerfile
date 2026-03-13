ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js and dependencies
RUN apk add --no-cache nodejs npm bash

# Set working directory
WORKDIR /app

# Copy package files first (better caching)
COPY package.json package-lock.json* ./
RUN npm ci --only=production 2>/dev/null || npm install --production

# Copy bot files
COPY bot.js ./
COPY run.sh ./
RUN chmod a+x /app/run.sh

ENTRYPOINT ["/app/run.sh"]
