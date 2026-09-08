/**
 * es-reporter.mjs
 * Custom @elastic/synthetics reporter that pushes results directly to
 * Elasticsearch — bypassing Heartbeat / Elastic Agent entirely.
 *
 * Usage:
 *   SYNTHETICS_ES_URL=https://... SYNTHETICS_ES_KEY=... \
 *   npx @elastic/synthetics --reporter ./es-reporter.mjs journey.js
 *
 * Config can also be passed via synthetics.config.js (see example).
 */

import { createRequire } from 'module';
import { createRunContext, transformEvent } from './transform.mjs';
import { ESClient } from './es-client.mjs';
import { SYNTHETICS_VERSION, ECS_VERSION, AGENT_TYPE, AGENT_VERSION, KIBANA_SPACE, DS_BROWSER, DS_SCREENSHOT } from './constants.mjs';

const require = createRequire(import.meta.url);
const { gatherScreenshots, getScreenshotBlocks, formatNetworkFields } = require('@elastic/synthetics/dist/reporters/json');
const { CACHE_PATH } = require('@elastic/synthetics/dist/helpers');
const snakecaseKeys = require('snakecase-keys');
const { join } = require('path');

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------
const ES_URL     = process.env.SYNTHETICS_ES_URL;
const ES_KEY     = process.env.SYNTHETICS_ES_KEY;
const DEBUG      = process.env.SYNTHETICS_ES_DEBUG === 'true';
const BATCH_SIZE = 50;
const TARGET_DS  = DS_BROWSER;

function loadMonitorConfig() {
  // Prefer environment variables, fall back to synthetics.config.js
  const cfg = {
    id:       process.env.MONITOR_ID       ?? 'local-monitor-001',
    name:     process.env.MONITOR_NAME     ?? 'Local Monitor',
    schedule: Number(process.env.MONITOR_SCHEDULE ?? '10'), // minutes
    location: {
      name: process.env.MONITOR_LOCATION_NAME ?? 'local',
      geo:  process.env.MONITOR_LOCATION_GEO  ?? null,
    },
    tags:        (process.env.MONITOR_TAGS ?? '').split(',').filter(Boolean),
    serviceName: process.env.MONITOR_SERVICE ?? null,
  };

  // Validate
  if (!ES_URL) throw new Error('SYNTHETICS_ES_URL env var is required');
  if (!ES_KEY) throw new Error('SYNTHETICS_ES_KEY env var is required');

  return cfg;
}

// ---------------------------------------------------------------------------
// Reporter class — must be default export, extends nothing (duck-typed)
// @elastic/synthetics will call: new ESReporter(options)
// ---------------------------------------------------------------------------
export default class ESReporter {
  constructor(_options = {}) {
    try {
      this._monitorCfg = loadMonitorConfig();
      this._client     = new ESClient({ url: ES_URL, apiKey: ES_KEY, debug: DEBUG });
      this._ctx        = null;   // created on journey start
      this._buffer     = [];     // pending docs
      this._ready      = true;
    } catch (err) {
      console.error(`[es-reporter] Config error: ${err.message}`);
      this._ready = false;
    }
  }

  // --- Lifecycle hooks -------------------------------------------------------

  onStart(_event) {
    if (!this._ready) return;
    console.log(`[es-reporter] Run started → target: ${TARGET_DS}`);
  }

  onJourneyRegister(_journey) {
    // Nothing to do here
  }

  onJourneyStart(journey, { timestamp }) {
    if (!this._ready) return;

    // One context per journey — resets check_group and index counter
    this._ctx = createRunContext(this._monitorCfg);

    // Override journey id/name with what's declared in the journey file
    // (monitor.id from config is the stable identifier, not the journey name)
    const event = {
      type:            'journey/start',
      '@timestamp':    timestamp,
      journey:         { name: journey.name, id: journey.id, tags: journey.tags },
      root_fields:     { os: { platform: process.platform }, package: { name: '@elastic/synthetics', version: '1.x' } },
      package_version: SYNTHETICS_VERSION,
    };

    this._push(event);
  }

  onStepEnd(journey, step, { pagemetrics, traces, metrics }) {
    if (!this._ready || !this._ctx) return;

    // Track first URL visited for monitor details panel
    if (step.url && !this._ctx.firstUrl) {
      this._ctx.firstUrl = step.url;
    }

    // Emit step/metrics for relative_trace (CDP performance timeline)
    const tracesArr = Array.isArray(traces) ? traces : traces ? [traces] : [];
    for (const trace of tracesArr) {
      if (!trace) continue;
      this._push({
        type:            'step/metrics',
        '@timestamp':    Date.now() * 1000,
        journey:         { name: journey.name, id: journey.id },
        step:            { name: step.name, index: step.index, status: step.status },
        root_fields:     { browser: { relative_trace: trace } },
        package_version: SYNTHETICS_VERSION,
      });
    }

    // Emit step/metrics for experience (LCP, FCP, etc.)
    const metricsArr = Array.isArray(metrics) ? metrics : metrics ? [metrics] : [];
    for (const m of metricsArr) {
      if (!m) continue;
      this._push({
        type:            'step/metrics',
        '@timestamp':    Date.now() * 1000,
        journey:         { name: journey.name, id: journey.id },
        step:            { name: step.name, index: step.index, status: step.status },
        root_fields:     { browser: { experience: m } },
        package_version: SYNTHETICS_VERSION,
      });
    }

    const event = {
      type:            'step/end',
      '@timestamp':    Date.now() * 1000,
      journey:         { name: journey.name, id: journey.id, tags: journey.tags, status: journey.status },
      step: {
        name:     step.name,
        index:    step.index,
        status:   step.status,
        duration: step.duration ? { us: step.duration * 1e6 } : undefined,
      },
      root_fields:     { os: { platform: process.platform }, package: { name: '@elastic/synthetics', version: '1.x' } },
      payload: {
        source:     step.cb?.toString(),
        url:        step.url,
        status:     step.status,
        pagemetrics,
      },
      error:           step.error ? { name: step.error.name, message: step.error.message, stack: step.error.stack } : undefined,
      url:             step.url,
      package_version: SYNTHETICS_VERSION,
    };

    this._push(event);
  }

  async _pushScreenshots(journey) {
    const screenshotsPath = join(CACHE_PATH, 'screenshots');
    const ctx = this._ctx;
    const cfg = this._monitorCfg;
    const scheduleSec = cfg.schedule * 60;

    const envelope = {
      data_stream: { type: 'synthetics', dataset: 'browser.screenshot', namespace: 'default' },
      ecs:         { version: ECS_VERSION },
      agent: {
        id:           ctx.agentId,
        name:         `synthetics-local-${process.env.HOSTNAME ?? 'local'}`,
        type:         AGENT_TYPE,
        version:      AGENT_VERSION,
        ephemeral_id: ctx.ephemeralId,
      },
      monitor: {
        id:            cfg.id,
        name:          cfg.name,
        type:          'browser',
        origin:        'ui',
        check_group:   ctx.checkGroup,
        timespan:      ctx.timespan,
        interval:      scheduleSec,
        fleet_managed: true,
      },
      observer: {
        name: process.env.HOSTNAME ?? 'local',
        geo:  { name: cfg.location?.name ?? 'local' },
      },
      config_id: cfg.id,
      meta:      { space_id: KIBANA_SPACE },
      tags:      cfg.tags?.length ? cfg.tags : undefined,
    };

    await gatherScreenshots(screenshotsPath, async (screenshot) => {
      const { data, timestamp, step } = screenshot;
      const ts = new Date(Math.round((timestamp ?? Date.now() * 1000) / 1000)).toISOString();

      try {
        const { blob_mime, blocks, reference } = await getScreenshotBlocks(
          Buffer.from(data, 'base64')
        );

        const blockDocs = blocks.map(block => ({
          ...envelope,
          '@timestamp': ts,
          synthetics:   { type: 'screenshot/block', blob: block.blob, blob_mime },
          event:        { type: 'screenshot/block', dataset: 'browser.screenshot' },
          _targetIndex: DS_SCREENSHOT,
          _id:          block.id,   // Kibana fetches blocks by hash as _id
        }));

        const refDoc = {
          ...envelope,
          '@timestamp':   ts,
          synthetics: {
            type:            'step/screenshot_ref',
            package_version: SYNTHETICS_VERSION,
            journey:         { name: journey.name, id: journey.id },
            step:            { name: step.name, index: step.index },
          },
          screenshot_ref: reference,   // top-level, not inside synthetics
          event:          { type: 'step/screenshot_ref', dataset: 'browser.screenshot' },
          _targetIndex:   DS_SCREENSHOT,
        };

        await this._client.bulk(DS_SCREENSHOT, [...blockDocs, refDoc]);
        if (DEBUG) console.log(`[es-reporter] Screenshot pushed for step: ${step.name}`);
      } catch (err) {
        console.error(`[es-reporter] Screenshot push failed: ${err.message}`);
      }
    });
  }

  async onJourneyEnd(journey, { timestamp, networkinfo }) {
    if (!this._ready || !this._ctx) return;

    // Flush network info events — use formatNetworkFields for correct ECS mapping
    if (networkinfo?.length) {
      for (const ni of networkinfo) {
        const { ecs, payload } = formatNetworkFields(ni);
        this._push({
          type:            'journey/network_info',
          '@timestamp':    ni.timestamp ?? Date.now() * 1000,
          journey:         { name: journey.name, id: journey.id },
          step:            ni.step,
          root_fields:     snakecaseKeys(ecs),
          payload:         snakecaseKeys(payload),
          package_version: SYNTHETICS_VERSION,
        });
      }
    }

    // Journey end
    const event = {
      type:            'journey/end',
      '@timestamp':    timestamp,
      url:             this._ctx.firstUrl,
      journey: {
        name:     journey.name,
        id:       journey.id,
        tags:     journey.tags,
        status:   journey.status,
        duration: journey.duration ? { us: journey.duration * 1e6 } : undefined,
      },
      root_fields:     { os: { platform: process.platform }, package: { name: '@elastic/synthetics', version: '1.x' } },
      payload: {
        status:                  journey.status,
        browser_delay_us:        0,
        process_startup_epoch_us: process.hrtime.bigint ? Number(process.hrtime.bigint() / 1000n) : Date.now() * 1000,
      },
      error:           journey.error ? { name: journey.error.name, message: journey.error.message, stack: journey.error.stack } : undefined,
      package_version: SYNTHETICS_VERSION,
    };

    this._push(event);
    await this._pushScreenshots(journey);
  }

  async onEnd() {
    if (!this._ready) return;
    await this._flush();
    console.log(`[es-reporter] Done. All documents pushed to ${TARGET_DS}`);
  }

  // --- Internal helpers ------------------------------------------------------

  _push(rawEvent) {
    if (!this._ctx) return;

    const result = transformEvent(rawEvent, this._ctx);
    const batch = Array.isArray(result) ? result : result ? [result] : [];
    if (!batch.length) return;

    this._buffer.push(...batch);

    if (this._buffer.length >= BATCH_SIZE) {
      // Fire-and-forget mid-run flush
      this._flush().catch(err => console.error('[es-reporter] Flush error:', err));
    }
  }

  async _flush() {
    if (!this._buffer.length) return;

    const batch = this._buffer.splice(0);
    try {
      await this._client.bulk(TARGET_DS, batch);
      if (DEBUG) console.log(`[es-reporter] Flushed ${batch.length} docs`);
    } catch (err) {
      console.error(`[es-reporter] ES push failed: ${err.message}`);
      // Restore to buffer so we don't lose docs silently
      this._buffer.unshift(...batch);
    }
  }
}
