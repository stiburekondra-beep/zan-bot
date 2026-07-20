'use strict';

const yaml = require('js-yaml');

const ENTITY_ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;

function isEntityId(value) {
  return typeof value === 'string' && ENTITY_ID_RE.test(value.trim());
}

function addEntity(found, value) {
  if (isEntityId(value)) found.add(value.trim());
}

function addEntityIdValue(found, value) {
  if (Array.isArray(value)) {
    for (const item of value) addEntityIdValue(found, item);
    return;
  }
  if (value && typeof value === 'object') {
    walkDashboardNode(value, found);
    return;
  }
  addEntity(found, value);
}

function walkDashboardNode(node, found) {
  if (Array.isArray(node)) {
    for (const item of node) walkDashboardNode(item, found);
    return;
  }

  if (!node || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node)) {
    if (key === 'entity') {
      addEntity(found, value);
    } else if (key === 'entity_id') {
      addEntityIdValue(found, value);
    } else if (key === 'entities') {
      addEntityIdValue(found, value);
    }

    walkDashboardNode(value, found);
  }
}

function extractDashboardEntitiesFromYaml(content) {
  const parsed = yaml.load(content);
  const found = new Set();
  walkDashboardNode(parsed, found);
  return [...found];
}

module.exports = {
  extractDashboardEntitiesFromYaml,
};
