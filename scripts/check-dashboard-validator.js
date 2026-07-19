#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { extractDashboardEntitiesFromYaml } = require('../dashboard-validator');

function sorted(values) {
  return [...values].sort();
}

const dashboard = `
title: Test
views:
  - title: Main
    cards:
      - type: entities
        entities:
          - light.kitchen
          - entity: sensor.temperature
            name: Teplota
          - type: divider
      - type: button
        entity: switch.boiler
        tap_action:
          action: call-service
          service: light.turn_on
          target:
            entity_id:
              - light.garden
              - light.kitchen
          data:
            entity_id: input_boolean.guest_mode
      - type: conditional
        conditions:
          - entity: binary_sensor.window
            state: "on"
        card:
          type: tile
          entity: climate.living_room
`;

assert.deepStrictEqual(sorted(extractDashboardEntitiesFromYaml(dashboard)), sorted([
  'binary_sensor.window',
  'climate.living_room',
  'input_boolean.guest_mode',
  'light.garden',
  'light.kitchen',
  'sensor.temperature',
  'switch.boiler',
]));

const ignoresNonEntities = `
cards:
  - type: markdown
    content: "sensor.fake_in_text is documentation, not an entity key"
  - type: picture
    image: /local/zan/floor.plan.png
`;

assert.deepStrictEqual(extractDashboardEntitiesFromYaml(ignoresNonEntities), []);

assert.throws(
  () => extractDashboardEntitiesFromYaml('views:\n  - title: Broken\n    title: Duplicate\n'),
  /duplicated mapping key/
);

console.log('Dashboard validator contract OK');
