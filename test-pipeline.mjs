/**
 * test-pipeline.mjs
 * Simulates @elastic/synthetics --reporter json output and validates the
 * transformation pipeline without launching a real browser.
 *
 * Usage:
 *   node test-pipeline.mjs             # dry-run (prints docs, does not push)
 *   node test-pipeline.mjs --push      # pushes documents to Elasticsearch
 */

import { createRunContext, transformEvent } from './transform.mjs';
import { ESClient } from './es-client.mjs';
import { DS_BROWSER, SYNTHETICS_VERSION } from './constants.mjs';

const DRY_RUN  = !process.argv.includes('--push');
const NOW_US   = Date.now() * 1000;

// ---------------------------------------------------------------------------
// Simulated JSON reporter output — mirrors `--reporter json` format
// ---------------------------------------------------------------------------
const FAKE_NDJSON = [
  {
    type: 'synthetics/metadata',
    '@timestamp': NOW_US,
    root_fields: { num_journeys: 1, os: { platform: 'linux' }, package: { name: '@elastic/synthetics', version: SYNTHETICS_VERSION } },
    package_version: SYNTHETICS_VERSION,
  },
  {
    type: 'journey/register',
    '@timestamp': NOW_US + 1000,
    journey: { name: 'Homepage Check', id: 'homepage-check', tags: [] },
    package_version: SYNTHETICS_VERSION,
  },
  {
    type: 'journey/start',
    '@timestamp': NOW_US + 2000,
    journey: { name: 'Homepage Check', id: 'homepage-check', tags: [] },
    root_fields: { os: { platform: 'linux' }, package: { name: '@elastic/synthetics', version: SYNTHETICS_VERSION } },
    payload: { source: 'async () => { await page.goto("https://www.elastic.co"); }' },
    package_version: SYNTHETICS_VERSION,
  },
  {
    type: 'step/end',
    '@timestamp': NOW_US + 1_200_000,
    journey: { name: 'Homepage Check', id: 'homepage-check', tags: [], status: 'succeeded' },
    step: { name: 'Open homepage', index: 0, status: 'succeeded', duration: { us: 1_150_000 } },
    root_fields: { os: { platform: 'linux' }, package: { name: '@elastic/synthetics', version: SYNTHETICS_VERSION } },
    payload: { source: 'async () => { await page.goto(...) }', url: 'https://www.elastic.co/', status: 'succeeded' },
    url: 'https://www.elastic.co/',
    package_version: SYNTHETICS_VERSION,
  },
  {
    type: 'step/end',
    '@timestamp': NOW_US + 1_500_000,
    journey: { name: 'Homepage Check', id: 'homepage-check', tags: [], status: 'succeeded' },
    step: { name: 'Check page title', index: 1, status: 'succeeded', duration: { us: 280_000 } },
    root_fields: { os: { platform: 'linux' }, package: { name: '@elastic/synthetics', version: SYNTHETICS_VERSION } },
    payload: { source: 'async () => { const title = await page.title() ... }', status: 'succeeded' },
    url: 'https://www.elastic.co/',
    package_version: SYNTHETICS_VERSION,
  },
  {
    type: 'step/end',
    '@timestamp': NOW_US + 1_800_000,
    journey: { name: 'Homepage Check', id: 'homepage-check', tags: [], status: 'succeeded' },
    step: { name: 'Check main navigation', index: 2, status: 'succeeded', duration: { us: 210_000 } },
    root_fields: { os: { platform: 'linux' }, package: { name: '@elastic/synthetics', version: SYNTHETICS_VERSION } },
    payload: { status: 'succeeded' },
    package_version: SYNTHETICS_VERSION,
  },
  {
    type: 'journey/network_info',
    '@timestamp': NOW_US + 1_000_000,
    journey: { name: 'Homepage Check', id: 'homepage-check' },
    step: { name: 'Open homepage', index: 0 },
    root_fields: {
      url: 'https://www.elastic.co/',
      http: { request: { method: 'GET', bytes: 0 }, response: { status: 200, bytes: 48_210, mime_type: 'text/html' } },
      user_agent: { name: 'Chrome', version: '124.0' },
    },
    payload: { type: 'Document', isNavigationRequest: true, timings: { total: 980 } },
    package_version: SYNTHETICS_VERSION,
  },
  {
    type: 'journey/end',
    '@timestamp': NOW_US + 2_100_000,
    journey: {
      name:     'Homepage Check',
      id:       'homepage-check',
      tags:     [],
      status:   'succeeded',
      duration: { us: 2_098_000 },
    },
    root_fields: { os: { platform: 'linux' }, package: { name: '@elastic/synthetics', version: SYNTHETICS_VERSION } },
    payload: {
      status:                   'succeeded',
      browser_delay_us:         180_000,
      process_startup_epoch_us: NOW_US,
    },
    package_version: SYNTHETICS_VERSION,
  },
];

// ---------------------------------------------------------------------------
// Run the pipeline
// ---------------------------------------------------------------------------
const monitorConfig = {
  id:          process.env.MONITOR_ID            ?? 'test-monitor-001',
  name:        process.env.MONITOR_NAME          ?? 'Test Monitor',
  schedule:    Number(process.env.MONITOR_SCHEDULE ?? '10'),
  location: {
    name: process.env.MONITOR_LOCATION_NAME      ?? 'local-dev',
    geo:  process.env.MONITOR_LOCATION_GEO       ?? '48.8566, 2.3522',
  },
  tags:        ['poc', 'local'],
  serviceName: 'elastic-website',
};

console.log('╔════════════════════════════════════════════════════╗');
console.log('║  Synthetics ES Pusher — Pipeline Test              ║');
console.log('╚════════════════════════════════════════════════════╝\n');

const ctx = createRunContext(monitorConfig);
console.log('Monitor config:');
console.log(`  id:           ${ctx.monitorId}`);
console.log(`  name:         ${ctx.monitorName}`);
console.log(`  check_group:  ${ctx.checkGroup}`);
console.log(`  location:     ${ctx.locationName}`);
console.log(`  timespan:     ${ctx.timespan.gte} → ${ctx.timespan.lt}`);
console.log('');

const docs = [];
let skipped = 0;

for (const event of FAKE_NDJSON) {
  const result = transformEvent(event, ctx);
  const batch = Array.isArray(result) ? result : result ? [result] : [];
  if (batch.length) {
    docs.push(...batch);
  } else {
    skipped++;
  }
}

console.log(`Processed ${FAKE_NDJSON.length} events → ${docs.length} docs, ${skipped} skipped\n`);

docs.forEach((doc) => {
  const status = doc.monitor?.status ?? '-';
  const type   = doc.synthetics?.type ?? '?';
  const step   = doc.synthetics?.step?.name ? ` [${doc.synthetics.step.name}]` : '';
  const idx    = doc.synthetics?.index ?? '?';
  const ts     = doc['@timestamp'];
  console.log(`  [${String(idx).padStart(2)}] ${type.padEnd(25)}${step.padEnd(30)} status=${status}  @ts=${ts}`);
});

// Validate key fields on journey/end doc
console.log('\n── journey/end doc validation ──────────────────────────');
const endDoc = docs.find(d => d.synthetics?.type === 'journey/end');
if (endDoc) {
  const checks = [
    ['monitor.id',            endDoc.monitor?.id],
    ['monitor.name',          endDoc.monitor?.name],
    ['monitor.status',        endDoc.monitor?.status],
    ['monitor.check_group',   endDoc.monitor?.check_group],
    ['monitor.timespan',      JSON.stringify(endDoc.monitor?.timespan)],
    ['monitor.type',          endDoc.monitor?.type],
    ['monitor.fleet_managed', endDoc.monitor?.fleet_managed],
    ['data_stream.type',      endDoc.data_stream?.type],
    ['data_stream.dataset',   endDoc.data_stream?.dataset],
    ['agent.type',            endDoc.agent?.type],
    ['agent.version',         endDoc.agent?.version],
    ['ecs.version',           endDoc.ecs?.version],
    ['synthetics.type',       endDoc.synthetics?.type],
    ['synthetics.index',      endDoc.synthetics?.index],
    ['observer.geo.name',     endDoc.observer?.geo?.name],
    ['config_id',             endDoc.config_id],
    ['@timestamp',            endDoc['@timestamp']],
  ];
  for (const [field, value] of checks) {
    const ok = value !== undefined && value !== null;
    console.log(`  ${ok ? '✓' : '✗'} ${field.padEnd(30)} ${ok ? String(value).slice(0, 60) : 'MISSING'}`);
  }
} else {
  console.warn('  ✗ No journey/end doc found!');
}

// ---------------------------------------------------------------------------
// Push to ES if --push flag is set
// ---------------------------------------------------------------------------
if (!DRY_RUN) {
  const ES_URL = process.env.SYNTHETICS_ES_URL;
  const ES_KEY = process.env.SYNTHETICS_ES_KEY;

  if (!ES_URL || !ES_KEY) {
    console.error('\nSet SYNTHETICS_ES_URL and SYNTHETICS_ES_KEY to push.');
    process.exit(1);
  }

  const client = new ESClient({ url: ES_URL, apiKey: ES_KEY, debug: true });
  console.log(`\nPushing ${docs.length} docs to ${DS_BROWSER}...`);
  await client.bulk(DS_BROWSER, docs);
  console.log('\n✓ Done! Check Kibana → Observability → Synthetics');
} else {
  console.log('\n[DRY RUN] Add --push to actually index documents.');
  console.log('          Set SYNTHETICS_ES_URL and SYNTHETICS_ES_KEY first.\n');
}
