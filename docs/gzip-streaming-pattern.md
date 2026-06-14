# Gzip Streaming Pattern in `opencode-bundle-patch`

**Date**: 2026-06-14  
**Author**: orchestrator + user (incident report)  
**Severity**: silent empty-body bug, only visible in production

## The bug

When adding gzip decompression to a Node.js HTTP proxy, **all four** event handlers must be on the decompressed stream (`source`), not the raw upstream response (`upstreamRes`):

```js
// CORRECT
const ce = (upstreamRes.headers['content-encoding'] || '').toLowerCase();
let source = upstreamRes;
if (ce === 'gzip' || ce === 'deflate') {
  source = upstreamRes.pipe(zlib.createGunzip());
  source.on('error', (err) => { console.error('[gunzip error]', err.message); });
}

source.on('data', (c) => { chunks.push(c); total += c.length; });
source.on('end', () => { /* process chunks */ });
source.on('error', (err) => { /* handle error AFTER response is sent */ });
```

## Why this matters

`upstreamRes.on('end')` fires when the raw compressed bytes are fully received. But the gunzip stream (`source`) is still working through them. So the `end` callback runs **before** the `data` events from `source` have populated the buffer. Result: `chunks` is empty, body is empty, `JSON.parse('')` fails, proxy returns 0 bytes to client.

The `on('error')` handlers have the same problem.

## Symptom

UI shows empty agent dropdown. Server health: `tools: 4 (expected >=5)`. Proxy log: `[agent-filter] parse-fail (passthrough) size=0->0`.

The single biggest tell: **`size=0->0` in proxy log** = body was empty. If you see this, the issue is server-side (proxy), not client-side (UI).

## Why curl doesn't reproduce

`curl --compressed` does its own gunzip on the client side. The proxy returns raw gzipped bytes (because the agent-filter code path failed to parse the empty buffer), curl decompresses them, and reports success. But the UI uses `/agent?directory=...` (with directory param) which goes through the agent-filter path. Curl tested `/api/agent` (simple passthrough) — different code path, looked fine.

**Always test with `curl -H "Accept-Encoding: gzip"` AND with the exact path/query the UI uses.**

## Checklist for future gzip proxy fixes

When applying gzip handling to ANY HTTP proxy in this stack:

- [ ] `const zlib = require('zlib');` imported
- [ ] `source = upstreamRes.pipe(zlib.createGunzip())` (only if content-encoding is gzip/deflate)
- [ ] `source.on('error', ...)` for gunzip errors
- [ ] `source.on('data', ...)` (NOT `upstreamRes.on('data', ...)`)
- [ ] `source.on('end', ...)` (NOT `upstreamRes.on('end', ...)`)
- [ ] `source.on('error', ...)` (NOT `upstreamRes.on('error', ...)`) — the SECOND error handler after response is sent

Test with: `curl -s -H "Accept-Encoding: gzip" --compressed http://.../api/agent | python3 -c "import sys,json; print(len(json.load(sys.stdin)))"`

If you see `size=0->0` in proxy log: gzip handling is broken.

## Files in this stack

- `/home/opencode/.opencode-staging/opencode-bundle-patch/server.js` (prod) — FIXED 2026-06-14 20:39 (user)
- `/home/opencode/.opencode-staging/opencode-bundle-patch-sandbox/server.js` (sandbox) — FIXED 2026-06-14 22:50 (orchestrator, after user reported)

If you ever need to apply gzip handling to another proxy in this stack, **copy ALL FOUR event handlers**, not just `on('data')`.

## Reference

- User's incident report: `/data/projects/SFFMC/.slim/deepwork/prod-gzip-fix-applied.md` (or similar — see conversation history)
- Original gzip incident: 2026-06-14 17:00-20:39 UTC, ~3.5 hours of debugging before root cause identified
