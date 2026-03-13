ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js
RUN apk add --no-cache nodejs npm

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install --production

# Copy bot
COPY bot.js ./
COPY run.sh ./
RUN chmod +x run.sh

CMD ["/app/run.sh"]
