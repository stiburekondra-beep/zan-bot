#!/usr/bin/env node
/**
 * Jednorázový průzkum: jaké signálové entity (LQI / RSSI / linkquality) v HA jsou.
 * Slouží jako podklad pro signálový dashboard. Nic nemění, jen čte.
 *
 * Spuštění:  node scripts/zjisti-signalove-entity.js
 */
require('dotenv').config();
const axios = require('axios');

const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;

if (!HA_URL || !HA_TOKEN) {
  console.error('Chybí HA_URL nebo HA_TOKEN v .env');
  process.exit(1);
}

(async () => {
  const r = await axios.get(`${HA_URL}/api/states`, {
    headers: { Authorization: `Bearer ${HA_TOKEN}` },
    timeout: 20000,
  });
  const states = r.data;
  console.log('entit celkem:', states.length);

  const signal = states.filter(s =>
    /_lqi$|_rssi$|_linkquality$|link_quality|signal_strength/i.test(s.entity_id)
  );
  console.log('\n=== SIGNÁLOVÉ ENTITY (' + signal.length + ') ===');
  for (const s of signal) {
    console.log([
      s.entity_id.padEnd(52),
      String(s.state).padStart(6),
      (s.attributes.unit_of_measurement || '').padEnd(4),
      s.attributes.friendly_name || '',
    ].join(' | '));
  }

  // orientace: kolik je vůbec zigbee zařízení a jaké domény
  const zigbee = states.filter(s => /zigbee|zha|z2m/i.test(JSON.stringify(s.attributes || {})));
  console.log('\nentit se zmínkou o zigbee v atributech:', zigbee.length);

  const domeny = {};
  for (const s of states) {
    const d = s.entity_id.split('.')[0];
    domeny[d] = (domeny[d] || 0) + 1;
  }
  console.log('\ndomény:', JSON.stringify(domeny));
})().catch(e => {
  console.error('CHYBA:', e.message);
  process.exit(1);
});
