ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js and dependencies
RUN apk add --no-cache nodejs npm bash

# Set working directory
WORKDIR /app

# Copy package files first (better caching)
COPY package.json ./
RUN npm install --production

# Copy bot files
COPY bot.js ./

# Setup s6 service
RUN mkdir -p /etc/services.d/zan/
COPY run.sh /etc/services.d/zan/run
RUN chmod a+x /etc/services.d/zan/run

