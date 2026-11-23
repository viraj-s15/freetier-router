import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import { registerDiscoveredModels } from '../../services/builtin-model-discovery.js';
import {
  blocksAutomaticDiscovery,
  deleteTombstonedCatalogModels,
  getCatalogModelTombstone,
  isCatalogModelTombstoned,
  recordCatalogModelTombstone,
} from '../../services/model-state.js';

// freetier-router: how catalog sync treats rows found by built-in discovery,
// and the catalog_removed tombstone that keeps discovery from re-adding a
// model the catalog dropped. The stale-snapshot guard (MIN_CATALOG_VERSION)
// is covered in catalog-sync.test.ts.

type AnyCatalog = Parameters<typeof applyCatalog>[1];

function catalogModel(platform: string, modelId: string, over: Partial<AnyCatalog['models'][number]> = {}): AnyCatalog['models'][number] {
  return {
    platform,
    modelId,
    displayName: `${modelId} (catalog)`,
    intelligenceRank: 10,
    speedRank: 5,
    sizeLabel: 'Large',
    limits: { rpm: 30, rpd: 1000, tpm: null, tpd: null },
    monthlyTokenBudget: '~1M',
    contextWindow: 131072,
    enabled: true,
    supportsVision: false,
    supportsTools: true,
    ...over,
  };
}

function catalogOf(models: AnyCatalog['models']): AnyCatalog {
  return { version: '2099.01.01', generatedAt: new Date().toISOString(), tier: 'monthly', models, quirks: [] };
}

function row(platform: string, modelId: string) {
  return getDb().prepare('SELECT id, source, enabled, rpm_limit, rpd_limit FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number; source: string; enabled: number; rpm_limit: number | null; rpd_limit: number | null } | undefined;
}

let baseline: AnyCatalog['models'] = [];

describe('catalog sync and discovered models', () => {
  afterEach(() => {
    delete process.env.DISCOVERED_MODEL_CHECKS;
  });

  beforeEach(() => {
    delete process.env.DISCOVERED_MODEL_CHECKS;
    initDb(':memory:');
    baseline = (getDb().prepare("SELECT platform, model_id FROM models WHERE source = 'catalog'").all() as Array<{ platform: string; model_id: string }>)
      .map(r => catalogModel(r.platform, r.model_id));
  });

  it('keeps an unlisted discovered model on a catalog-managed platform, unchanged', () => {
    const db = getDb();
    registerDiscoveredModels(db, 'groq', [{ modelId: 'new-model' }], { explicit: false });
    const before = row('groq', 'new-model');
    applyCatalog(db, catalogOf(baseline));
    expect(row('groq', 'new-model')).toEqual(before);
  });

  it('adopts a listed discovered model and sets the catalog limits', () => {
    const db = getDb();
    registerDiscoveredModels(db, 'groq', [{ modelId: 'new-model' }], { explicit: false });
    applyCatalog(db, catalogOf([...baseline, catalogModel('groq', 'new-model', { limits: { rpm: 30, rpd: 900, tpm: null, tpd: null } })]));
    expect(row('groq', 'new-model')).toMatchObject({ source: 'catalog', rpm_limit: 30, rpd_limit: 900, enabled: 1 });
  });

  it('keeps an operator disable when it adopts a discovered model', () => {
    // With the checks on, a new row is already off, so the disable is tested on a row that started on.
    process.env.DISCOVERED_MODEL_CHECKS = 'off';
    const db = getDb();
    registerDiscoveredModels(db, 'groq', [{ modelId: 'new-model' }], { explicit: false });
    db.prepare("UPDATE models SET enabled = 0 WHERE platform = 'groq' AND model_id = 'new-model'").run();
    applyCatalog(db, catalogOf([...baseline, catalogModel('groq', 'new-model')]));
    expect(row('groq', 'new-model')).toMatchObject({ source: 'catalog', enabled: 0 });
  });

  it('records a catalog_removed tombstone when it prunes a catalog row', () => {
    const db = getDb();
    applyCatalog(db, catalogOf([...baseline, catalogModel('groq', 'old-model')]));
    expect(row('groq', 'old-model')).toMatchObject({ source: 'catalog' });
    applyCatalog(db, catalogOf(baseline));
    expect(row('groq', 'old-model')).toBeUndefined();
    expect(getCatalogModelTombstone(db, 'chat', 'groq', 'old-model')?.source).toBe('catalog_removed');
  });

  it('leaves an operator tombstone as it is when it prunes', () => {
    const db = getDb();
    applyCatalog(db, catalogOf([...baseline, catalogModel('groq', 'old-model')]));
    recordCatalogModelTombstone(db, 'chat', 'groq', 'old-model');
    applyCatalog(db, catalogOf(baseline));
    expect(getCatalogModelTombstone(db, 'chat', 'groq', 'old-model')?.source).toBe('user');
  });

  it('clears a catalog_removed tombstone and adds the model when the catalog lists it again', () => {
    const db = getDb();
    recordCatalogModelTombstone(db, 'chat', 'groq', 'old-model', { source: 'catalog_removed' });
    applyCatalog(db, catalogOf([...baseline, catalogModel('groq', 'old-model')]));
    expect(getCatalogModelTombstone(db, 'chat', 'groq', 'old-model')).toBeUndefined();
    expect(row('groq', 'old-model')).toMatchObject({ source: 'catalog' });
  });

  it('keeps a model deleted when an operator tombstone exists and the catalog lists it', () => {
    const db = getDb();
    recordCatalogModelTombstone(db, 'chat', 'groq', 'old-model');
    applyCatalog(db, catalogOf([...baseline, catalogModel('groq', 'old-model')]));
    expect(row('groq', 'old-model')).toBeUndefined();
    expect(getCatalogModelTombstone(db, 'chat', 'groq', 'old-model')?.source).toBe('user');
  });
});

describe('catalog_removed tombstones', () => {
  beforeEach(() => {
    initDb(':memory:');
  });

  it('block automatic discovery like an operator deletion, and an upstream retirement does not', () => {
    const db = getDb();
    recordCatalogModelTombstone(db, 'chat', 'groq', 'a');
    recordCatalogModelTombstone(db, 'chat', 'groq', 'b', { source: 'catalog_removed' });
    recordCatalogModelTombstone(db, 'chat', 'groq', 'c', { source: 'upstream_eol', reason: '410' });
    expect(blocksAutomaticDiscovery(db, 'chat', 'groq', 'a')).toBe(true);
    expect(blocksAutomaticDiscovery(db, 'chat', 'groq', 'b')).toBe(true);
    expect(blocksAutomaticDiscovery(db, 'chat', 'groq', 'c')).toBe(false);
    expect(blocksAutomaticDiscovery(db, 'chat', 'groq', 'none')).toBe(false);
  });

  it('do not count as operator deletions', () => {
    const db = getDb();
    recordCatalogModelTombstone(db, 'chat', 'groq', 'b', { source: 'catalog_removed' });
    expect(isCatalogModelTombstoned(db, 'chat', 'groq', 'b')).toBe(false);
    expect(getCatalogModelTombstone(db, 'chat', 'groq', 'b')?.source).toBe('catalog_removed');
  });

  it('never delete a row that exists for the model', () => {
    const db = getDb();
    registerDiscoveredModels(db, 'groq', [{ modelId: 'kept' }], { explicit: false });
    recordCatalogModelTombstone(db, 'chat', 'groq', 'kept', { source: 'catalog_removed' });
    expect(deleteTombstonedCatalogModels(db)).toBe(0);
    expect(row('groq', 'kept')).toBeDefined();
  });
});
