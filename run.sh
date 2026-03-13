#!/usr/bin/with-contenv bashio

# Načti config z HA add-on options
export TELEGRAM_TOKEN=$(bashio::config 'TELEGRAM_TOKEN')
export CHAT_ID_ONDRA=$(bashio::config 'CHAT_ID_ONDRA')
export CHAT_ID_JANA=$(bashio::config 'CHAT_ID_JANA')
export EXTRA_CHAT_IDS=$(bashio::config 'EXTRA_CHAT_IDS')
export ANTHROPIC_API_KEY=$(bashio::config 'ANTHROPIC_API_KEY')
export OPENAI_API_KEY=$(bashio::config 'OPENAI_API_KEY')
export PLANTID_API_KEY=$(bashio::config 'PLANTID_API_KEY')

# HA přístup přes supervisor
export HA_URL="http://supervisor/core"
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export HA_CONFIG_PATH="/config"

bashio::log.info "Žán Bot startuje..."

cd /app
exec node bot.js
