# 已删除的一次性调试脚本

清理时间：2026-10-06T08:42:33.829Z

这些脚本是为排查一次性问题写的，里面写死了本机绝对路径
（`D:/GLB`、`E:/直播/...`），换机器全部作废，留着只会误导。
需要时可以从 git 历史找回。

| 文件 | 大小 |
| --- | --- |
| `scripts/check-91.cjs` | 0.8 KB |
| `scripts/check-packets.cjs` | 0.8 KB |
| `scripts/check-recent-projects.cjs` | 0.6 KB |
| `scripts/check-selected-segments.cjs` | 0.9 KB |
| `scripts/diag-409.cjs` | 1.8 KB |
| `scripts/diag-busy.cjs` | 3.4 KB |
| `scripts/diag-cancel-latency.cjs` | 2.6 KB |
| `scripts/diag-cancel-rerun.cjs` | 2.7 KB |
| `scripts/diag-candidates.cjs` | 2.4 KB |
| `scripts/diag-cut-granularity.cjs` | 1.9 KB |
| `scripts/diag-id-vs-index.cjs` | 1.4 KB |
| `scripts/diag-memory-picks.cjs` | 1.1 KB |
| `scripts/diag-no-text.cjs` | 1.2 KB |
| `scripts/diag-path-match.cjs` | 0.8 KB |
| `scripts/diag-pick53.cjs` | 1.5 KB |
| `scripts/diag-punct-fail.cjs` | 2.6 KB |
| `scripts/diag-range.cjs` | 1.8 KB |
| `scripts/diag-recut-empty.cjs` | 4.5 KB |
| `scripts/diag-rerun-where.cjs` | 3.0 KB |
| `scripts/diag-stale-refs.cjs` | 1.4 KB |
| `scripts/diag-status-timeline.cjs` | 2.3 KB |
| `scripts/diag-text-empty.cjs` | 1.8 KB |
| `scripts/diag-text-range.mjs` | 1.0 KB |
| `scripts/diag-themes.cjs` | 1.6 KB |
| `scripts/diag-where-stuck.cjs` | 3.4 KB |
| `scripts/dump-hermes-stack.cjs` | 4.2 KB |
| `scripts/dump-packet.cjs` | 0.6 KB |
| `scripts/dump-review-dom.mjs` | 2.1 KB |
| `scripts/e2e-save-archive.mjs` | 5.4 KB |
| `scripts/fetch-live-result.cjs` | 1.3 KB |
| `scripts/final-health-check.cjs` | 4.7 KB |
| `scripts/find-candidate-source.cjs` | 2.0 KB |
| `scripts/find-fk.cjs` | 0.6 KB |
| `scripts/fix-analysis-health.cjs` | 2.5 KB |
| `scripts/fix-asset-index.cjs` | 3.4 KB |
| `scripts/fix-broken-paths.cjs` | 4.4 KB |
| `scripts/fix-duplicate-review.cjs` | 2.6 KB |
| `scripts/fix-live-status.cjs` | 3.6 KB |
| `scripts/fix-stale-counts.cjs` | 4.6 KB |
| `scripts/fix-superseded-segments.cjs` | 5.5 KB |
| `scripts/fix-zero-length-segments.cjs` | 3.8 KB |
| `scripts/list-segments.cjs` | 1.3 KB |
| `scripts/make-review-project.cjs` | 2.9 KB |
| `scripts/probe-buttons.mjs` | 1.6 KB |
| `scripts/probe-click-each.mjs` | 3.2 KB |
| `scripts/probe-cross-seg.mjs` | 6.9 KB |
| `scripts/probe-cut-e2e.mjs` | 4.5 KB |
| `scripts/probe-expand.mjs` | 2.6 KB |
| `scripts/probe-history.mjs` | 1.1 KB |
| `scripts/probe-hit-prediction.mjs` | 11.7 KB |
| `scripts/probe-hotword-placement.mjs` | 9.5 KB |
| `scripts/probe-hotword.mjs` | 5.6 KB |
| `scripts/probe-ip-dblclick.mjs` | 4.8 KB |
| `scripts/probe-ip-dual-create.mjs` | 4.0 KB |
| `scripts/probe-karaoke.mjs` | 5.8 KB |
| `scripts/probe-layout.cjs` | 5.7 KB |
| `scripts/probe-leave-import.mjs` | 4.1 KB |
| `scripts/probe-open.mjs` | 3.5 KB |
| `scripts/probe-project-name.cjs` | 0.9 KB |
| `scripts/probe-renderer.mjs` | 3.4 KB |
| `scripts/probe-ui-perf.cjs` | 12.3 KB |
| `scripts/repro-recut.cjs` | 3.3 KB |
| `scripts/run-analyze.cjs` | 1.9 KB |
| `scripts/shot-review.mjs` | 3.0 KB |
| `scripts/verify-cancel-detect.cjs` | 6.7 KB |
| `scripts/verify-compose-e2e.cjs` | 12.0 KB |
| `scripts/verify-compose.cjs` | 8.4 KB |
| `scripts/verify-e2e.cjs` | 5.1 KB |
| `scripts/verify-engine-sync.cjs` | 4.6 KB |
| `scripts/verify-filters.cjs` | 9.1 KB |
| `scripts/verify-gemini-ready.cjs` | 5.4 KB |
| `scripts/verify-installed-features.cjs` | 6.4 KB |
| `scripts/verify-installed-fixes.cjs` | 1.2 KB |
| `scripts/verify-installed.cjs` | 4.8 KB |
| `scripts/verify-memory-e2e.cjs` | 4.2 KB |
| `scripts/verify-memory-isolation.cjs` | 6.2 KB |
| `scripts/verify-memory-picks.cjs` | 4.0 KB |
| `scripts/verify-opening.cjs` | 8.0 KB |
| `scripts/verify-preview.cjs` | 7.2 KB |
| `scripts/verify-projects.cjs` | 5.0 KB |
| `scripts/verify-punctuation-model.cjs` | 3.1 KB |
| `scripts/verify-punctuation.cjs` | 4.2 KB |
| `scripts/verify-range.cjs` | 4.7 KB |
| `scripts/verify-reopen.cjs` | 7.1 KB |
| `scripts/verify-results.cjs` | 6.2 KB |
| `scripts/verify-review-approve.cjs` | 4.0 KB |
| `scripts/verify-review-text.cjs` | 2.7 KB |
| `scripts/verify-review.cjs` | 7.1 KB |
| `scripts/verify-themes-db.cjs` | 2.0 KB |
| `scripts/verify-themes.cjs` | 4.1 KB |
| `scripts/verify-timeout-recovery.cjs` | 3.9 KB |
| `scripts/verify-trimmer.cjs` | 8.2 KB |
| `scripts/verify-ui.mjs` | 8.3 KB |
| `scripts/verify-variant-opening-toggle.cjs` | 3.2 KB |
| `scripts/verify-variant-pick.cjs` | 5.7 KB |
| `scripts/verify-variants.cjs` | 4.3 KB |
| `scripts/verify-vault-ipc.cjs` | 14.4 KB |
| `scripts/verify-wrap.cjs` | 8.0 KB |
| `scripts/which-are-real.cjs` | 1.5 KB |

## 保留的脚本

- `scripts/run-hidden.ps1`
- `scripts/clean-e2e-assets.cjs`
- `scripts/clean-test-projects.cjs`
- `scripts/clean-test-review-comments.cjs`
- `scripts/cleanup-draft.cjs`
- `scripts/cleanup-hook.cjs`
- `scripts/cleanup-probe-ips.mjs`
- `scripts/cleanup-test-data.cjs`
- `scripts/attrib-feedback.cjs`
