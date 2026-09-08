/**
 * transform.mjs
 * Maps @elastic/synthetics JSON reporter events → Elasticsearch documents
 * compatible with the synthetics-browser-default data stream.
 */

import { randomUUID } from 'crypto';
import { URL } from 'url';
import { hostname } from 'os';
import { SYNTHETICS_VERSION, ECS_VERSION, AGENT_TYPE, AGENT_VERSION, KIBANA_SPACE, DS_BROWSER } from './constants.mjs';

// ---------------------------------------------------------------------------
// Context — generated once per run, shared across all events
// ---------------------------------------------------------------------------
export function createRunContext(monitorConfig) {
  const runStart = new Date();
  const scheduleSec = monitorConfig.schedule * 60; // schedule is in minutes

  return {
    monitorId:    monitorConfig.id,
    monitorName:  monitorConfig.name,
    schedule:     monitorConfig.schedule,
    locationName: monitorConfig.location?.name ?? 'local',
    locationGeo:  monitorConfig.location?.geo  ?? null,
    tags:         monitorConfig.tags ?? [],
    serviceName:  monitorConfig.serviceName ?? null,

    // Generated
    checkGroup:   randomUUID() + '-0',
    agentId:      monitorConfig.agentId ?? randomUUID(),
    ephemeralId:  randomUUID(),
    runStart,

    // Computed timespan: { gte: runStart, lt: runStart + schedule }
    timespan: {
      gte: runStart.toISOString(),
      lt:  new Date(runStart.getTime() + scheduleSec * 1000).toISOString(),
    },

    // Sequential index counter across all events in the run
    _indexCounter: 0,
    nextIndex() { return this._indexCounter++; },
  };
}

// ---------------------------------------------------------------------------
// Timestamp: JSON reporter emits microseconds, ES expects ISO 8601
// ---------------------------------------------------------------------------
function tsToISO(tsMicros) {
  return new Date(Math.round(tsMicros / 1000)).toISOString();
}

// ---------------------------------------------------------------------------
// URL parsing — safe wrapper
// ---------------------------------------------------------------------------
function parseUrl(rawUrl) {
  if (!rawUrl) return {};
  try {
    const u = new URL(rawUrl);
    return {
      full:   rawUrl,
      scheme: u.protocol.replace(':', ''),
      domain: u.hostname,
      path:   u.pathname,
      port:   u.port ? Number(u.port) : undefined,
      query:  u.search ? u.search.slice(1) : undefined,
    };
  } catch {
    return { full: rawUrl };
  }
}

// ---------------------------------------------------------------------------
// Base envelope — fields shared by every document
// ---------------------------------------------------------------------------
function baseDoc(event, ctx) {
  const scheduleSec = ctx.schedule * 60;

  const doc = {
    '@timestamp': tsToISO(event['@timestamp']),

    data_stream: {
      type:      'synthetics',
      dataset:   'browser',
      namespace: 'default',
    },

    ecs: { version: ECS_VERSION },

    agent: {
      id:           ctx.agentId,
      name:         `synthetics-local-${hostname()}`,
      type:         AGENT_TYPE,
      version:      AGENT_VERSION,
      ephemeral_id: ctx.ephemeralId,
    },

    observer: {
      name: hostname(),
      geo: {
        name:     ctx.locationName,
        ...(ctx.locationGeo ? { location: ctx.locationGeo } : {}),
      },
    },

    monitor: {
      id:            ctx.monitorId,
      name:          ctx.monitorName,
      type:          'browser',
      origin:        ctx.monitorOrigin ?? 'ui',
      check_group:   ctx.checkGroup,
      timespan:      ctx.timespan,
      interval:      scheduleSec,
      fleet_managed: true,
    },

    config_id: ctx.monitorId,

    meta:  { space_id: KIBANA_SPACE },
    tags:  ctx.tags.length ? ctx.tags : undefined,

    synthetics: {
      type:            event.type,
      index:           ctx.nextIndex(),
      package_version: event.package_version,
    },

    event: {
      type:    event.type,
      dataset: 'browser',
    },

    os:      event.root_fields?.os,
    package: event.root_fields?.package,
  };

  if (ctx.serviceName) doc.service = { name: ctx.serviceName };

  return doc;
}

// ---------------------------------------------------------------------------
// Event type transformers
// ---------------------------------------------------------------------------

export function transformMetadata(event, ctx) {
  // synthetics/metadata — not indexed as a standalone doc, skip
  return null;
}

export function transformJourneyStart(event, ctx) {
  const doc = baseDoc(event, ctx);
  doc.synthetics.journey = {
    name: event.journey?.name,
    id:   event.journey?.id,
    tags: event.journey?.tags,
  };
  doc.monitor.status = 'up'; // unknown yet, optimistic
  return doc;
}

export function transformStepEnd(event, ctx) {
  const doc = baseDoc(event, ctx);

  const stepStatus  = event.step?.status ?? 'failed';
  const journeyStatus = event.journey?.status ?? 'failed';

  doc.synthetics.journey = {
    name: event.journey?.name,
    id:   event.journey?.id,
    tags: event.journey?.tags,
  };
  doc.synthetics.step = {
    name:     event.step?.name,
    index:    event.step?.index,
    status:   stepStatus,
    duration: event.step?.duration,
  };
  doc.synthetics.payload = event.payload ?? {};

  // monitor.status at step level = step outcome
  doc.monitor.status = stepStatus === 'succeeded' ? 'up' : 'down';

  if (event.error) {
    doc.synthetics.error = {
      name:    event.error.name,
      message: event.error.message,
      stack:   event.error.stack,
    };
  }

  if (event.url) doc.url = parseUrl(event.url);

  return doc;
}

export function transformJourneyEnd(event, ctx) {
  const doc = baseDoc(event, ctx);

  const status = event.journey?.status ?? 'failed';
  const monitorStatus = status === 'succeeded' ? 'up' : 'down';

  doc.synthetics.journey = {
    name:     event.journey?.name,
    id:       event.journey?.id,
    tags:     event.journey?.tags,
    duration: event.journey?.duration,
  };
  doc.synthetics.payload = event.payload ?? {};
  doc.monitor.status     = monitorStatus;
  doc.monitor.duration   = event.journey?.duration;

  if (event.error) {
    doc.synthetics.error = {
      name:    event.error.name,
      message: event.error.message,
      stack:   event.error.stack,
    };
  }

  return doc;
}

// Kibana Synthetics UI reads heartbeat/summary to compute monitor status.
// This is a separate doc generated alongside journey/end.
export function transformHeartbeatSummary(journeyEndEvent, ctx) {
  const doc = baseDoc({ ...journeyEndEvent, type: 'heartbeat/summary' }, ctx);

  const status = journeyEndEvent.journey?.status ?? 'failed';
  const monitorStatus = status === 'succeeded' ? 'up' : 'down';

  // Strip check_group suffix (-0) to get retry_group
  const retryGroup = ctx.checkGroup.replace(/-\d+$/, '');

  doc.synthetics = { type: 'heartbeat/summary' };
  doc.event      = { type: 'heartbeat/summary', dataset: 'browser' };

  doc.monitor.status   = monitorStatus;
  doc.monitor.duration = journeyEndEvent.journey?.duration;

  if (journeyEndEvent.url) doc.url = parseUrl(journeyEndEvent.url);

  doc.summary = {
    retry_group:   retryGroup,
    max_attempts:  1,
    attempt:       1,
    final_attempt: true,
    up:            monitorStatus === 'up' ? 1 : 0,
    down:          monitorStatus === 'down' ? 1 : 0,
    status:        monitorStatus,
  };

  // Minimal state (Kibana uses this for flap detection / history)
  doc.state = {
    status:     monitorStatus,
    up:         monitorStatus === 'up' ? 1 : 0,
    down:       monitorStatus === 'down' ? 1 : 0,
    checks:     1,
    flap_history: [],
    started_at: ctx.timespan.gte,
    ends:       null,
    id:         `${ctx.locationName}-${retryGroup}-0`,
    duration_ms: String(journeyEndEvent.journey?.duration?.us
      ? Math.round(journeyEndEvent.journey.duration.us / 1000)
      : 0),
  };

  return doc;
}

export function transformStepMetrics(event, ctx) {
  const doc = baseDoc(event, ctx);

  doc.synthetics.journey = {
    name: event.journey?.name,
    id:   event.journey?.id,
  };
  doc.synthetics.step = {
    name:   event.step?.name,
    index:  event.step?.index,
    status: event.step?.status,
    duration: { us: 0 },
  };

  // browser.relative_trace or browser.experience lives at top level
  if (event.root_fields?.browser) {
    doc.browser = event.root_fields.browser;
  }

  doc.monitor.status = 'up';
  return doc;
}

export function transformNetworkInfo(event, ctx) {
  const doc = baseDoc(event, ctx);
  doc.synthetics.journey = {
    name: event.journey?.name,
    id:   event.journey?.id,
  };
  if (event.step) {
    doc.synthetics.step = {
      name:  event.step?.name,
      index: event.step?.index,
    };
  }
  doc.synthetics.payload = event.payload ?? {};

  // ECS http/url from root_fields (network_info uses snakeCaseKeys)
  if (event.root_fields) {
    const rf = event.root_fields;
    if (rf.url)          doc.url          = parseUrl(rf.url);
    if (rf.http)         doc.http         = rf.http;
    if (rf.tls)          doc.tls          = rf.tls;
    if (rf.user_agent)   doc.user_agent   = rf.user_agent;
  }

  doc.monitor.status = 'up';
  return doc;
}

export function transformScreenshotBlock(event, ctx) {
  // Goes to synthetics-browser.screenshot-default — handled separately
  const doc = baseDoc(event, ctx);
  doc.synthetics.blob      = event.blob;
  doc.synthetics.blob_mime = event.blob_mime;
  doc._targetIndex = 'synthetics-browser.screenshot-default'; // routing hint
  return doc;
}

export function transformScreenshotRef(event, ctx) {
  const doc = baseDoc(event, ctx);
  doc.synthetics.journey  = { name: event.journey?.name, id: event.journey?.id };
  doc.synthetics.step     = { name: event.step?.name, index: event.step?.index };
  if (event.root_fields?.screenshot_ref) {
    doc.screenshot_ref = event.root_fields.screenshot_ref;
  }
  doc._targetIndex = 'synthetics-browser.screenshot-default';
  return doc;
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------
// Returns a single doc, an array of docs, or null.
export function transformEvent(event, ctx) {
  switch (event.type) {
    case 'synthetics/metadata':   return null;
    case 'journey/register':      return null;
    case 'journey/start':         return transformJourneyStart(event, ctx);
    case 'step/end':              return transformStepEnd(event, ctx);
    case 'step/metrics':          return transformStepMetrics(event, ctx);
    case 'step/filmstrips':       return null;
    case 'journey/network_info':  return transformNetworkInfo(event, ctx);
    case 'journey/browserconsole':return null;
    case 'journey/end':           return [
      transformJourneyEnd(event, ctx),
      transformHeartbeatSummary(event, ctx),
    ];
    case 'screenshot/block':      return transformScreenshotBlock(event, ctx);
    case 'step/screenshot':       return null;
    case 'step/screenshot_ref':   return transformScreenshotRef(event, ctx);
    default:
      console.warn(`[es-reporter] Unknown event type: ${event.type}`);
      return null;
  }
}
