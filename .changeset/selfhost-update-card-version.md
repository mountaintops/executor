---
"@executor-js/host-selfhost": patch
"@executor-js/host-cloudflare": patch
"@executor-js/react": patch
---

Fix the self-host and Cloudflare web dashboards showing "update available" even on the latest version. The builds baked a placeholder version (`0.0.0-selfhost` / `0.0.0-cloudflare`) into the shell, so the update check always compared as behind. They now bake the real release version, and the sidebar footer shows the running version so you can see what you are on.
