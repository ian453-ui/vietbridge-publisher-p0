# V1 task visibility patch

`v1-task-visibility.patch` is an isolated UI fix from the exact running Publisher V1 release, not a patch against this unified source or the older P0 `main` branch. It changes completed failures to historical display and keeps uncertain submissions in a read-only reconciliation section. Its original V1 test suite passed 249/249. Apply only after porting against the correct V1 source and re-running checks. No production V1 deployment has occurred.

Patch SHA-256: `d183baa8ad5a6ae4f6289cc506fbaff436c26bab7391e5c67341b696b92b9f75`.
