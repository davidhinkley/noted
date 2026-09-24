// worker.js - Web Worker for building Fuse.js search index
// Handles buildIndex computation off the main thread to prevent blocking search()

const { buildIndex } = self.module;

// Listen for messages from the main thread
self.onmessage = async (event) => {
  const { action, ...params } = event;
  
  switch (action) {
    case 'buildIndex':
      // Build the Fuse index in the worker
      const index = await buildIndex();
      self.postMessage({ type: 'indexReady', index });
      break;
      
    case 'getIndex':
      // Return the index for use in search
      self.postMessage({ type: 'indexReady', index });
      break;
  }
};
