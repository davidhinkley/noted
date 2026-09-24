# deployment.md

## Version Bump

- **Version**: 1.0.0
- **Bump Type**: Major
- **Reason**: Release ritual - initial stable release
- **Changes**:
  - Initial release of NOTED v1.0.0
  - Includes search index optimization (T33)
  - Architecture updates (T34)

## Build Configuration

- **Build System**: Buildless (no build step)
- **Deployment**: Static files, subdirectory-relative paths
- **Service Worker**: Sw.js with CACHE_VERSION bump mechanism
- **Storage**: IndexedDB via Dexie.js
- **Search**: Fuse.js with worker offloading for >2,000 notes

## Trigger Measurements

- **~2,000-note threshold**: Search performance degrades significantly beyond 2,000 notes. Index building should be offloaded to a Web Worker (T33).
- **Vue/Svelte migration**: T34 - triggers-doc task for future migration
