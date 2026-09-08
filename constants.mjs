/**
 * constants.mjs
 * Central place for values that appear in multiple files.
 * Override via environment variables where indicated.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// @elastic/synthetics version — read from installed package
export const SYNTHETICS_VERSION = require('@elastic/synthetics/package.json').version;

// Elasticsearch data streams
export const DS_BROWSER       = 'synthetics-browser-default';
export const DS_SCREENSHOT    = 'synthetics-browser.screenshot-default';

// ECS / agent envelope — these must match what Kibana expects
export const ECS_VERSION      = '8.0.0';
export const AGENT_TYPE       = 'heartbeat';
export const AGENT_VERSION    = process.env.SYNTHETICS_AGENT_VERSION ?? '9.1.0';

// Kibana space — override if you use a non-default space
export const KIBANA_SPACE     = process.env.MONITOR_SPACE ?? 'default';
