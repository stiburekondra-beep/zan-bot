function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAutoSeededDeviceRecord(key, value) {
  if (!isPlainObject(value)) return false;
  const allowedKeys = ['name', 'entity_id', 'domain', 'state'];
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some(k => !allowedKeys.includes(k))) return false;
  if (value.entity_id !== key) return false;
  if (!value.domain || key.split('.')[0] !== value.domain) return false;
  return Object.prototype.hasOwnProperty.call(value, 'state');
}

function cleanDeviceMemory(devices) {
  const kept = {};
  const removed = [];
  for (const [key, value] of Object.entries(devices || {})) {
    if (isAutoSeededDeviceRecord(key, value)) removed.push(key);
    else kept[key] = value;
  }
  return { devices: kept, removed };
}

function formatMemoryValue(value) {
  if (isPlainObject(value)) {
    if (value.name && value.area) return `${value.name} (${value.area})`;
    if (value.name) return value.name;
    return JSON.stringify(value);
  }
  return String(value);
}

function formatMemoryMap(entries, limit = 25) {
  const all = Object.entries(entries || {});
  const shown = all.slice(0, limit).map(([key, value]) => `- ${key}: ${formatMemoryValue(value)}`);
  if (all.length > limit) shown.push(`- ... a dalsich ${all.length - limit}`);
  return shown.join('\n');
}

module.exports = {
  cleanDeviceMemory,
  formatMemoryMap,
  isAutoSeededDeviceRecord,
};
