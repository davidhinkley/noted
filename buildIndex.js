// buildIndex.js
// Build index for Fuse.js search. This file is moved into a Web Worker (T33) to avoid blocking the main thread during search.

const FUSE = require('../js/search.js');

// Build a Fuse.js index from the Dexie database
async function buildIndex() {
  const db = await Dexie.from('notes');
  const notes = await db.all();
  
  // Extract searchable fields (excluding internal/external fields)
  const searchableNotes = notes.map(n => ({
    id: n.id,
    title: n.title,
    body: n.body,
    tags: n.tags,
    folderId: n.folderId,
    updatedAt: n.updatedAt,
    createdAt: n.createdAt,
    deletedAt: n.deletedAt
  }));
  
  // Build Fuse index
  const index = new Fuse(searchableNotes, {
    keys: 'title,body,tags,folderId,updatedAt',
    maxOccursPerType: 5
  });
  
  return index;
}

module.exports = { buildIndex };
