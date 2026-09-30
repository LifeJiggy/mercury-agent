# Response to SSRF advisory (issue #108)

Status: **Fixed — current releases not affected.** Issue closed as fixed.

## Summary

A responsible-disclosure report (issue #108, dated 2026-08-06) described
authenticated SSRF via the `fetch_url` tool: model-driven `fetch()` with no
destination filtering, allowing a chat user to probe loopback / internal
endpoints and reflect response bodies back into the conversation.

- **Affected:** ≤ 1.1.13 — `fetch_url` called plain `fetch(url)` directly.
- **Fixed:** tool routed through the SSRF guard (`src/utils/ssrf.ts`) in the
  1.2.3 release; hardened via #121 and #124.

## Guard coverage

| Vector | Handling |
| --- | --- |
| Loopback / RFC 1918 / link-local (incl. `169.254.169.254`) / CGNAT / multicast | blocked |
| `localhost`, `.local`, `.internal` hostnames | blocked |
| Non-http(s) schemes | blocked |
| DNS answers containing any private record | fail-closed |
| Redirects | every hop re-validated (manual redirect mode) |
| DNS rebinding | validated address pinned to the socket |

## Verification

The report's PoC was reproduced against `main`: a loopback canary was never
contacted; all four attempted vectors were rejected by the guard. A sweep of
remaining `fetch()` call sites found only one raw fetch (Slack file upload),
which targets a URL issued by Slack's API — not model-controllable input.

## Maintenance notes

- `guardedFetch` is the only sanctioned path for model-reachable fetches.
- Re-run a sink sweep (`rg "fetch\(" src --type ts`) when adding new network
  surfaces; local-provider base URLs are exempt by design (loopback trust
  boundary, web server binds `127.0.0.1` only).