# Project File Map

This repository only publishes non-secret snippet code and the management Worker source.
Cloudflare API tokens, D1 IDs, account IDs, and private deployment values are not included.

| Project | Domain | Public source file | Obfuscated/minified file | Current role |
| --- | --- | --- | --- | --- |
| 111 | 111.freelx.net | `projects/111-us-managed-current.txt` | `projects/111-us-managed-current.min.js` | US managed snippet, no traffic metering hooks, current stable 111 restore code |
| 222 | 222.freelx.net | `projects/222-us-region-current.txt` | `projects/222-us-region-current.min.js` | US region-path snippet with temporary region override and 512KB upload queue |
| 333 | 333.freelx.net | `projects/333-hk-region-current.txt` | `projects/333-hk-region-current.min.js` | HK region-path snippet, 512KB upload queue |
| 444 | 444.freelx.net | `projects/444-us-light-current.txt` | `projects/444-us-light-current.min.js` | US light snippet, 222-style connection behavior with management-generated subscriptions |

Use the `.min.js` files for Cloudflare Snippets deployment. The `.txt` files are kept with matching content so GitHub can preview them more easily.

## Management Worker

`cf-vless-manager/manager-worker.js` is the current admin Worker source. The admin UI includes temporary subscription-region management.

## Notes

- 222 currently uses the region-path version restored from the pre-rollback backup.
- The 222 upload queue remains `524288` bytes.
- The admin restart flow now clears all snippet rules briefly, recreates the selected snippet, and then restores all rules. This matches the previously successful recovery method and avoids the 1101 state caused by partial rule updates.
