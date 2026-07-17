# Final Preload Port Report

## Task 6 Minor

Preload now closes and clears its private PCM `MessagePort` when a terminal remote ASR status (`error` or `idle`) arrives. Cleanup happens before the registered status callback runs, and the port remains private and inaccessible through the exposed API.

## TDD evidence

- RED: the two new error/idle tests failed because the callback observed `port.closed === false`.
- GREEN: after the minimal `onStatus` wrapper cleanup, both tests pass and `writePcm` throws `ASR is not recording`.

## Verification

- `npm run typecheck`: pass
- `npm run build`: pass
- `node --test tests/desktop/test_preload_asr_bridge.mjs`: 4 passed, 0 failed
- `npm run desktop-test`: 96 passed, 0 failed
- `git diff --check`: pass

## Commit

`fix: clear pcm port on remote asr termination`
