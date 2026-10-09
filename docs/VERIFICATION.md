# Verification — Text Workbench

2026-10-09. Observed results and pending manual checks are recorded separately.

Primary independently ran 45 Node tests, source check (8 public assets/12 JavaScript files), preview build (8 assets) and whitespace check before bilingual release changes. All passed. Actual source and fixtures were reviewed; the root workspace did not yet track this new tool, so whitespace checking alone was not treated as a complete review.

In Codex IAB on Windows, the native module Worker produced `A\nB` from ` A \nA\n\nB\nB` with all three options. HTML-looking input remained literal textarea text, with no img element or dialog observed. Editing options cleared the old result. Empty output remained successful, copy enabled and download disabled. Keyboard controls, clear-to-input focus and the 320 CSS px layout passed. Narrow action buttons were corrected and measured at 44 px tall.

A native downloaded `cleaned-text.txt` from `甲\nA` contained exactly `[231,148,178,10,65]`: UTF-8, no BOM and no extra newline.

A loopback-only controlled browser harness verified cancel/clear followed by late replies, an older reply during a newer job, 4,999 ms success, 5,000 ms rejection before the timer callback, watchdog expiry, malformed replies, missing Worker and injected clipboard denial. These are synthetic timing/failure scenarios, not actual device sleep, OS permission denial or offline tests. Denial retained the selectable result and download action.

TX18 remains **NOT_RUN** for complete real DevTools Network/Storage/offline inspection. Source review and CSP are supporting controls, not replacements. A fresh module Worker can require static asset loading, so offline operation is not guaranteed. Real clipboard permission refusal, physical mobile devices, Firefox/Safari, actual BFCache hit, screen reader, true 200% zoom, Lighthouse/Core Web Vitals, Search Console and actual indexing also remain **NOT_RUN**, with the user's authorization to retain manual pending items.

Delegation requested `gpt-6-luna` / `max`, accepted by the spawn tool; actual backend routing is unconfirmed. Primary integration, source review and acceptance are independent of child reports.

Bilingual source and live publication are complete with the manual exceptions listed above. See the final release record below.

## Bilingual release gate — primary acceptance
After fixing an English relative-asset checker defect, the primary independently ran all 56 tests (PASS), source check (10 assets/17 JS), preview build (10 files), production build and exact check (14 files), with fail-fast command handling. Both language pages were exercised in real IAB; English Worker A/B output, 320px controls (44px buttons, no overflow), language navigation/reset and desktop1024 layout passed. An earlier 55-test run passed tests but failed the actual source/build checks; that failure was retained and fixed, not counted as a passing release. Production metadata and headers are exact-source checked; the live release subsequently passed the checks below.

## Final live release

Public source: https://github.com/KYStr/glossquote-labs-text-workbench (PUBLIC), functional commit 6f994d40c2e28f64df3f5473e158277146b68b97; the final documentation-only commit does not change the deployed assets.

Live pages: https://text.glossquote.com/index.html and https://text.glossquote.com/en/index.html. Worker version 513bcb01-1f0e-45d3-b9cc-0603179997c9. Primary verified 12 public assets byte-for-byte and 34 real HTTPS GET/HEAD, MIME, security header, canonical/hreflang, robots/sitemap, redirects and404 checks. An immediate post-deploy check initially returned Cloudflare500 “Script not found”; after reachability recovered, the unchanged release passed the complete check. No redeploy or verification weakening was used to hide that failure.

Native live IAB Chinese and English Worker results passed. Both live homepage catalogs now list five tools; actual navigation to and from matching-language text pages passed. Homepage source 8635f003601514f824a348344620469b78545790 is PUBLIC and remote-verified, Worker 8f481496-07e2-4284-9457-6ad9b5be1195, with20 HTTPS checks and5 exact public assets.

The primary reviewed all implementation/helper changes, independently ran56 tool tests and12 homepage tests, and checked builds. No credential values were printed or published; only the exact user-authorized token file was passed to an isolated CLI child. Final Windows environment closure is recorded in the private workspace evidence. Manual NOT_RUN items above remain pending, rather than being counted as passes.
