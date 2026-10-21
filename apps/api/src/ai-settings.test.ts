import { randomBytes, randomUUID } from 'node:crypto';
import { createPool, runMigrations } from '@print-pantry/db';
import type { AiProviderUpdate } from '@print-pantry/contracts';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createAiSettingsService } from './ai-settings.js';
import { copilotSuggestionConfig } from './ai-providers.js';

const database = process.env.TEST_DATABASE_URL;
if (!database || new URL(database).pathname !== '/print_pantry_test') throw new Error('An isolated test database is required');
const pool = createPool(database);
const encryptionKey = randomBytes(32);
const listModels = vi.fn(async () => [{ id: 'account-model', name: 'Account model', vision: true }]);
const service = createAiSettingsService(pool, { encryptionKey, listModels });
const update: AiProviderUpdate = { kind: 'openai', name: 'Home OpenAI', credential: 'synthetic-credential', model: null,
  allowImages: false, supportsImages: false, maxInputChars: 40000, maxOutputTokens: 8000 };

beforeAll(async () => { await runMigrations(database); });
beforeEach(async () => { await pool.query('DELETE FROM site_ai_settings'); listModels.mockClear(); });
afterAll(async () => { await pool.query('DELETE FROM site_ai_settings'); await pool.end(); });

it('encrypts stored credentials and never returns them to settings clients', async () => {
  const id = randomUUID();
  const saved = await service.save(0, id, update);
  expect(saved.providers[0].hasCredential).toBe(true);
  expect(JSON.stringify(saved)).not.toContain(update.credential);
  const stored = await pool.query('SELECT configuration FROM site_ai_settings');
  expect(JSON.stringify(stored.rows)).not.toContain(update.credential);
  const restarted = createAiSettingsService(pool, { encryptionKey, listModels });
  await restarted.refreshModels(saved.revision, id);
  expect(listModels).toHaveBeenCalledWith('openai', update.credential);
});

it('requires an account model before choosing a default and detects stale updates', async () => {
  const id = randomUUID();
  let state = await service.save(0, id, update);
  await expect(service.setDefault(state.revision, id)).rejects.toThrow('Select a model');
  state = await service.refreshModels(state.revision, id);
  await expect(service.save(state.revision, id, { ...update, credential: undefined, model: 'invented' })).rejects.toThrow('available model');
  state = await service.save(state.revision, id, { ...update, credential: undefined, model: 'account-model' });
  state = await service.setDefault(state.revision, id);
  expect((await service.runtime()).credential).toBe(update.credential);
  await expect(service.remove(0, id)).rejects.toThrow('changed');
  state = await service.save(state.revision, randomUUID(), { ...update, kind: 'copilot', name: 'Copilot' });
  expect(state.providers).toHaveLength(2);
  state = await service.remove(state.revision, id);
  expect(state.defaultProviderId).toBeNull();
});

it('invalidates account models and the default when a credential is replaced', async () => {
  const id = randomUUID();
  let state = await service.save(0, id, update);
  state = await service.refreshModels(state.revision, id);
  state = await service.save(state.revision, id, { ...update, credential: undefined, model: 'account-model' });
  state = await service.setDefault(state.revision, id);
  state = await service.save(state.revision, id, { ...update, credential: 'replacement' });
  expect(state.defaultProviderId).toBeNull();
  expect(state.providers[0].models).toEqual([]);
});

it('fails closed without an encryption key and disables Copilot tools and ambient configuration', async () => {
  const unavailable = createAiSettingsService(pool, { listModels });
  expect((await unavailable.get()).encryptedStorageReady).toBe(false);
  await expect(unavailable.save(0, randomUUID(), update)).rejects.toThrow('encryption key');
  expect(copilotSuggestionConfig('account-model', 8000)).toMatchObject({ availableTools: [],
    enableConfigDiscovery: false, enableFileHooks: false, enableSkills: false, skipCustomInstructions: true,
    enableSessionStore: false, memory: { enabled: false } });
});

it('disables image sharing when refreshed model capabilities no longer allow images', async () => {
  let vision = true;
  const settings = createAiSettingsService(pool, { encryptionKey, listModels: async () => [{ id: 'account-model', name: 'Account model', vision }] });
  const id = randomUUID();
  let state = await settings.save(0, id, update);
  state = await settings.refreshModels(state.revision, id);
  state = await settings.save(state.revision, id, { ...update, credential: undefined, model: 'account-model', supportsImages: true, allowImages: true });
  vision = false;
  state = await settings.refreshModels(state.revision, id);
  expect(state.providers[0].allowImages).toBe(false);
  expect(state.providers[0].supportsImages).toBe(false);
});