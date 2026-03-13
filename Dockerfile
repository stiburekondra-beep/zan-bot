ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js, jq and dependencies
RUN apk add --no-cache nodejs npm bash jq

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install --production

# Copy bot
COPY bot.js ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# s6-overlay v3 service structure
RUN mkdir -p /etc/s6-overlay/s6-rc.d/zan/
RUN echo "longrun" > /etc/s6-overlay/s6-rc.d/zan/type
RUN cp /run.sh /etc/s6-overlay/s6-rc.d/zan/run
RUN chmod a+x /etc/s6-overlay/s6-rc.d/zan/run
RUN mkdir -p /etc/s6-overlay/s6-rc.d/user/contents.d
RUN touch /etc/s6-overlay/s6-rc.d/user/contents.d/zan

