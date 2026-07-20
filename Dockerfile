ARG BUILD_FROM
FROM $BUILD_FROM

# Install Node.js, jq, dependencies + nmap (sken domácí sítě — scan_network)
RUN apk add --no-cache nodejs npm bash jq nmap tzdata

ENV TZ=Europe/Prague

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install --production

# Copy bot
# POZOR: musí se vyjmenovat KAŽDÝ modul, který bot.js vyžaduje — jinak image
# spadne hned při startu na MODULE_NOT_FOUND (stalo se 2026-07-14 u v5.7.2:
# polling-watchdog.js se nezkopíroval a Žán se vůbec nespustil).
COPY bot.js ./
COPY budget-report.js ./
COPY onboard-device.js ./
COPY polling-watchdog.js ./
COPY run.sh /run.sh
RUN chmod a+x /run.sh

# s6-overlay v3 service structure
RUN mkdir -p /etc/s6-overlay/s6-rc.d/zan/
RUN echo "longrun" > /etc/s6-overlay/s6-rc.d/zan/type
RUN cp /run.sh /etc/s6-overlay/s6-rc.d/zan/run
RUN chmod a+x /etc/s6-overlay/s6-rc.d/zan/run
RUN mkdir -p /etc/s6-overlay/s6-rc.d/user/contents.d
RUN touch /etc/s6-overlay/s6-rc.d/user/contents.d/zan
