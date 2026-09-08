#!/usr/bin/env node
/**
 * push-results.mjs  — Option 3
 * Reads the JSON reporter NDJSON output (from stdin or file) and pushes to ES.
 *
 * Usage (piped):
 *   npx @elastic/synthetics --reporter json journey.js | \
 *     node push-results.mjs
 *
 * Usage (from file):
 *   npx @elastic/synthetics --reporter json journey.js > results.ndjson
 *   node push-results.mjs results.ndjson
 *
 * Env vars:
 *   SYNTHETICS_ES_URL    Elasticsearch endpoint
 *   SYNTHETICS_ES_KEY    API key
 *   MONITOR_ID           Monitor identifier
 *   MONITOR_NAME         Human-readable name
 *   MONITOR_SCHEDULE     Schedule in minutes (default: 10)
 *   MONITOR_LOCATION_NAME Location label (default: 'local')
 *   MONITOR_LOCATION_GEO  "lat, lon" string (optional)
 *   MONITOR_TAGS         Comma-separated tags (optional)
 *   MONITOR_SERVICE      service.name (optional)
 *   SYNTHETICS_ES_DEBUG  'true' for verbose output
 */

import { createReadStream } from 'fs';
import { createInterface }  from 'readline';
import { createRunContext, transformEvent } from './transform.mjs';
import { ESClient } from './es-client.mjs';
import { DS_BROWSER } from './constants.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const ES_URL = process.env.SYNTHETICS_ES_URL;
const ES_KEY = process.env.SYNTHETICS_ES_KEY;
const DEBUG  = process.env.SYNTHETICS_ES_DEBUG === 'true';
const TARGET = DS_BROWSER;

if (!ES_URL || !ES_KEY) {
  console.error('Error: SYNTHETICS_ES_URL and SYNTHETICS_ES_KEY must be set');
  process.exit(1);
}

const monitorConfig = {
  id:       process.env.MONITOR_ID            ?? 'local-monitor-001',
  name:     process.env.MONITOR_NAME          ?? 'Local Monitor',
  schedule: Number(process.env.MONITOR_SCHEDULE ?? '10'),
  location: {
    name: process.env.MONITOR_LOCATION_NAME   ?? 'local',
    geo:  process.env.MONITOR_LOCATION_GEO    ?? null,
  },
  tags:        (process.env.MONITOR_TAGS      ?? '').split(',').filter(Boolean),
  serviceName: process.env.MONITOR_SERVICE    ?? null,
};

// ---------------------------------------------------------------------------
// Read NDJSON from stdin or file argument
// ---------------------------------------------------------------------------
const inputFile = process.argv[2];
const source = inputFile
  ? createReadStream(inputFile)
  : process.stdin;

const rl = createInterface({ input: source, crlfDelay: Infinity });

// ---------------------------------------------------------------------------
// Process events
// ---------------------------------------------------------------------------
const client  = new ESClient({ url: ES_URL, apiKey: ES_KEY, debug: DEBUG });
const ctx     = createRunContext(monitorConfig);
const docs    = [];

console.log(`[push-results] Monitor: ${monitorConfig.name} (${monitorConfig.id})`);
console.log(`[push-results] Location: ${monitorConfig.location.name}`);
console.log(`[push-results] check_group: ${ctx.checkGroup}`);
console.log(`[push-results] Timespan: ${ctx.timespan.gte} → ${ctx.timespan.lt}`);

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // Ignore non-JSON lines (e.g. browser error messages to stderr)
    return;
  }

  const result = transformEvent(event, ctx);
  const batch = Array.isArray(result) ? result : result ? [result] : [];
  for (const doc of batch) {
    docs.push(doc);
    if (DEBUG) {
      console.log(`[push-results] Queued: ${doc.synthetics?.type} → index=${doc.synthetics?.index}`);
    }
  }
});

rl.on('close', async () => {
  if (!docs.length) {
    console.warn('[push-results] No documents to push. Did the journey produce any JSON output?');
    process.exit(0);
  }

  console.log(`\n[push-results] Pushing ${docs.length} documents to ${TARGET}...`);

  // Summary before push
  const byType = {};
  docs.forEach(d => {
    const t = d.synthetics?.type ?? 'unknown';
    byType[t] = (byType[t] ?? 0) + 1;
  });
  console.log('[push-results] By type:', byType);

  try {
    await client.bulk(TARGET, docs);
    console.log('[push-results] ✓ Done!\n');
    console.log('View results in Kibana:');
    console.log(`  Observability → Synthetics → monitor.id: ${monitorConfig.id}`);
  } catch (err) {
    console.error('[push-results] ✗ Push failed:', err.message);
    process.exit(1);
  }
});
