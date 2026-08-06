import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createViewerPool,
  type SyncInput,
  type ViewHandle,
  type ViewerPool,
} from '../desktop/src/renderer/viewer-pool.ts';

interface FakeView extends ViewHandle {
  destroyed: boolean;
  active: boolean;
  syncs: string[];
}

function setup(capacity: number): { pool: ViewerPool; views: Map<string, FakeView> } {
  const views = new Map<string, FakeView>();
  const pool = createViewerPool({
    capacity,
    createView(key: string): ViewHandle {
      const view: FakeView = {
        key,
        destroyed: false,
        active: false,
        syncs: [],
        setActive(active: boolean) { view.active = active; },
        sync(input: SyncInput) { view.syncs.push(input.content); },
        destroy() { view.destroyed = true; },
      };
      views.set(key, view);
      return view;
    },
  });
  return { pool, views };
}

const doc = (content: string): SyncInput => ({
  content,
  filename: 'a.md',
  workspaceName: 'alpha',
  workspaceFilePath: 'a.md',
});

describe('viewer pool', () => {
  let pool: ViewerPool;
  let views: Map<string, FakeView>;
  beforeEach(() => { ({ pool, views } = setup(3)); });

  it('creates a view on first activate', () => {
    pool.activate('f1:a.md', doc('# A'));
    assert.equal(pool.size(), 1);
    assert.equal(views.get('f1:a.md')?.syncs.length, 1);
  });

  it('reuses an existing view instead of recreating it', () => {
    pool.activate('f1:a.md', doc('# A'));
    const first = views.get('f1:a.md');
    pool.activate('f1:b.md', doc('# B'));
    pool.activate('f1:a.md', doc('# A'));
    assert.equal(views.get('f1:a.md'), first);
    assert.equal(first?.destroyed, false);
    assert.equal(pool.size(), 2);
  });

  it('marks only the activated view as active', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:b.md', doc('# B'));
    assert.equal(views.get('f1:a.md')?.active, false);
    assert.equal(views.get('f1:b.md')?.active, true);
  });

  it('hides the active view without evicting it', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.deactivate();
    assert.equal(views.get('f1:a.md')?.active, false);
    assert.equal(pool.has('f1:a.md'), true);
  });

  it('evicts the least recently used view at capacity', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:b.md', doc('# B'));
    pool.activate('f1:c.md', doc('# C'));
    pool.activate('f1:d.md', doc('# D'));
    assert.equal(views.get('f1:a.md')?.destroyed, true);
    assert.equal(pool.size(), 3);
    assert.equal(pool.has('f1:a.md'), false);
  });

  it('counts activation as recent use, sparing a revisited view', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:b.md', doc('# B'));
    pool.activate('f1:c.md', doc('# C'));
    pool.activate('f1:a.md', doc('# A'));   // a is now most recent, b is LRU
    pool.activate('f1:d.md', doc('# D'));
    assert.equal(views.get('f1:a.md')?.destroyed, false);
    assert.equal(views.get('f1:b.md')?.destroyed, true);
  });

  it('never evicts the active view', () => {
    const small = setup(1);
    small.pool.activate('f1:a.md', doc('# A'));
    small.pool.activate('f1:b.md', doc('# B'));
    assert.equal(small.views.get('f1:b.md')?.destroyed, false);
    assert.equal(small.views.get('f1:a.md')?.destroyed, true);
    assert.equal(small.pool.size(), 1);
  });

  it('re-syncs content when a previously evicted key is activated again', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:b.md', doc('# B'));
    pool.activate('f1:c.md', doc('# C'));
    pool.activate('f1:d.md', doc('# D'));  // evicts a
    pool.activate('f1:a.md', doc('# A v2'));
    assert.deepEqual(views.get('f1:a.md')?.syncs, ['# A v2']);
  });

  it('syncs an already-live view without recreating it', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f1:a.md', doc('# A edited'));
    assert.deepEqual(views.get('f1:a.md')?.syncs, ['# A', '# A edited']);
    assert.equal(pool.size(), 1);
  });

  it('returns the live view from acquire, or null when absent', () => {
    pool.activate('f1:a.md', doc('# A'));
    assert.equal(pool.acquire('f1:a.md')?.key, 'f1:a.md');
    assert.equal(pool.acquire('f1:zz.md'), null);
  });

  it('destroys every view belonging to a closed folder', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f2:z.md', doc('# Z'));
    pool.evictFolder('f1');
    assert.equal(views.get('f1:a.md')?.destroyed, true);
    assert.equal(views.get('f2:z.md')?.destroyed, false);
    assert.equal(pool.size(), 1);
  });

  it('does not evict a folder whose id is a prefix of another', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f10:b.md', doc('# B'));
    pool.evictFolder('f1');
    assert.equal(views.get('f10:b.md')?.destroyed, false);
    assert.equal(pool.has('f10:b.md'), true);
  });

  it('deactivates the previous view when a new folder view is activated', () => {
    pool.activate('f1:a.md', doc('# A'));
    pool.activate('f2:z.md', doc('# Z'));
    assert.equal(views.get('f1:a.md')?.active, false);
    assert.equal(views.get('f2:z.md')?.active, true);
  });

  it('handles relative paths containing a colon', () => {
    pool.activate('f1:notes/a:b.md', doc('# A'));
    assert.equal(pool.has('f1:notes/a:b.md'), true);
    pool.evictFolder('f1');
    assert.equal(pool.size(), 0);
  });
});
