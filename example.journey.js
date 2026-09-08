/**
 * example.journey.js
 * Sample journey — visits elastic.co and two product pages.
 * Replace the URLs and assertions with your own.
 */
import { journey, step, monitor } from '@elastic/synthetics';

journey('Elastic Website Check', ({ page }) => {
  monitor.use({
    id:       process.env.MONITOR_ID ?? 'elastic-website-check',
    name:     process.env.MONITOR_NAME ?? 'Elastic Website Check',
    schedule: 10,
  });

  step('Open homepage', async () => {
    await page.goto('https://www.elastic.co');
  });

  step('Check page title', async () => {
    const title = await page.title();
    if (!title.toLowerCase().includes('elastic')) {
      throw new Error(`Unexpected title: "${title}"`);
    }
  });

  step('Navigate to Elasticsearch product page', async () => {
    await page.goto('https://www.elastic.co/elasticsearch');
    await page.waitForSelector('h1', { timeout: 5000 });
    const h1 = await page.locator('h1').first().innerText();
    if (!h1.toLowerCase().includes('elasticsearch')) {
      throw new Error(`Unexpected h1: "${h1}"`);
    }
  });

  step('Navigate to Kibana product page', async () => {
    await page.goto('https://www.elastic.co/kibana');
    await page.waitForSelector('h1', { timeout: 5000 });
  });
});
