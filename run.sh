#!/bin/bash

# Načti config přímo z HA options souboru
export TELEGRAM_TOKEN=$(jq --raw-output '.TELEGRAM_TOKEN' /data/options.json)
export CHAT_ID_ONDRA=$(jq --raw-output '.CHAT_ID_ONDRA' /data/options.json)
export CHAT_ID_JANA=$(jq --raw-output '.CHAT_ID_JANA' /data/options.json)
export EXTRA_CHAT_IDS=$(jq --raw-output '.EXTRA_CHAT_IDS // ""' /data/options.json)
export ANTHROPIC_API_KEY=$(jq --raw-output '.ANTHROPIC_API_KEY' /data/options.json)
export OPENAI_API_KEY=$(jq --raw-output '.OPENAI_API_KEY' /data/options.json)
export PLANTID_API_KEY=$(jq --raw-output '.PLANTID_API_KEY // ""' /data/options.json)

# HA přístup přes supervisor
export HA_URL="http://supervisor/core"
export HA_TOKEN="${SUPERVISOR_TOKEN}"
export HA_CONFIG_PATH="/config"

echo "Žán Bot startuje..."
echo "DEBUG HA_URL: ${HA_URL}"
echo "DEBUG SUPERVISOR_TOKEN délka: ${#SUPERVISOR_TOKEN}"
echo "DEBUG HA_TOKEN délka: ${#HA_TOKEN}"

cd /app
exec node bot.js
