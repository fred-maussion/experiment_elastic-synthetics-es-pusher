#!/usr/bin/env node
/**
 * run-journey.mjs
 * Programmatic runner — bypasses CLI reporter restriction.
 * Loads journeys, runs them with ESReporter directly.
 *
 * Usage:
 *   source env && node run-journey.mjs [journey-file.js]
 *
 * Default journey: example.journey.js
 */

import { createRequire } from 'module';
import { pathToFileURL, fileURLToPath } from 'url';
import { resolve } from 'path';
import ESReporter from './es-reporter.mjs';

const require = createRequire(import.meta.url);
const { run } = require('@elastic/synthetics');

const journeyFile = process.argv[2] ?? 'example.journey.js';
const journeyPath = resolve(journeyFile);

const headless   = process.env.SYNTHETICS_HEADLESS !== 'false';   // default: true
const screenshots = process.env.SYNTHETICS_SCREENSHOTS ?? 'on';   // 'on' | 'off' | 'only-on-failure'

// Load the journey file (registers journeys via journey() calls)
await import(pathToFileURL(journeyPath).href);

const result = await run({
  reporter:    ESReporter,
  params:      {},
  playwrightOptions: {
    headless,
  },
  // Pass the journey file so the runner knows what to execute
  suiteParams: {},
  outfd:       process.stdout.fd,
  dryRun:      false,
  match:       '',
  tags:        [],
  pattern:     '',
  pauseOnError: false,
  screenshots,
  network:     true,
  metrics:     true,
  throttling:  false,
  quietExitCode: false,
});

process.exit(result.failed > 0 ? 1 : 0);
