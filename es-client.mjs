/**
 * es-client.mjs
 * Minimal Elasticsearch client — bulk indexing into data streams.
 * Uses native fetch (Node 18+), no SDK dependency.
 */

export class ESClient {
  constructor({ url, apiKey, debug = false }) {
    this.url    = url.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.debug  = debug;
  }

  _headers() {
    return {
      'Authorization': `ApiKey ${this.apiKey}`,
      'Content-Type':  'application/x-ndjson',
    };
  }

  /**
   * Bulk index documents into a data stream.
   * @param {string} defaultIndex - Target data stream (e.g. 'synthetics-browser-default')
   * @param {Array}  docs         - Array of plain objects { _targetIndex?, ...fields }
   */
  async bulk(defaultIndex, docs) {
    if (!docs.length) return;

    // Build NDJSON: action_meta + source pairs
    const lines = [];
    for (const doc of docs) {
      const idx = doc._targetIndex ?? defaultIndex;
      const { _targetIndex, _id, ...source } = doc;
      // Use 'index' (upsert) when _id is explicit so blocks are deduplicated by hash
      const meta = { _index: idx };
      if (_id) meta._id = _id;
      const action = { create: meta };
      lines.push(JSON.stringify(action));
      lines.push(JSON.stringify(source));
    }

    const body = lines.join('\n') + '\n';

    if (this.debug) {
      console.log(`[es-client] Sending ${docs.length} docs to ${defaultIndex}`);
      console.log('[es-client] First doc preview:', JSON.stringify(docs[0], null, 2).slice(0, 500));
    }

    const res = await fetch(`${this.url}/${defaultIndex}/_bulk`, {
      method:  'POST',
      headers: this._headers(),
      body,
    });

    const json = await res.json();

    if (json.errors) {
      const failures = json.items
        .filter(i => i.create?.error)
        .map(i => ({
          status: i.create.status,
          error:  i.create.error,
        }));
      console.error(`[es-client] Bulk errors (${failures.length}/${docs.length}):`);
      for (const f of failures.slice(0, 5)) {
        console.error(`  ${f.status} — ${f.error.type}: ${f.error.reason}`);
      }
    } else if (this.debug) {
      console.log(`[es-client] ✓ ${docs.length} docs indexed, took ${json.took}ms`);
    }

    return json;
  }

  /** Verify connectivity */
  async ping() {
    const res = await fetch(`${this.url}/`, {
      headers: {
        'Authorization': `ApiKey ${this.apiKey}`,
        'Content-Type':  'application/json',
      },
    });
    return res.ok;
  }
}
