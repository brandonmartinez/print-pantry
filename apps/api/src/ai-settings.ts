import type { FastifyInstance } from 'fastify';
import type { createPool } from '@print-pantry/db';
import type { AiModel, AiProviderKind, AiProviderProfile, AiProviderUpdate, SiteAiSettings } from '@print-pantry/contracts';
import type { createAuth } from './auth.js';
import { AiError, decryptAiSecret, encryptAiSecret } from './ai-secrets.js';

export type AiRuntimeProfile = AiProviderProfile & { credential: string };
type StoredProvider = Omit<AiProviderProfile, 'hasCredential'> & { encryptedCredential: string };
type Configuration = { defaultProviderId: string | null; providers: StoredProvider[] };
type Row = { revision: number; configuration: Configuration };
type Pool = ReturnType<typeof createPool>;
export type AiSettingsOptions = {
  encryptionKey?: Buffer;
  listModels: (kind: AiProviderKind, credential: string) => Promise<AiModel[]>;
};
const empty: Configuration = { defaultProviderId: null, providers: [] };

export function createAiSettingsService(pool: Pool, options: AiSettingsOptions) {
  function publicSettings(row: Row): SiteAiSettings {
    return { revision: row.revision, encryptedStorageReady: options.encryptionKey?.length === 32,
      defaultProviderId: row.configuration.defaultProviderId,
      providers: row.configuration.providers.map(({ encryptedCredential, ...provider }) => ({ ...provider, hasCredential: Boolean(encryptedCredential) })) };
  }
  async function read() {
    await pool.query("INSERT INTO site_ai_settings(id,configuration) VALUES('site',$1) ON CONFLICT DO NOTHING", [JSON.stringify(empty)]);
    return (await pool.query<Row>("SELECT revision,configuration FROM site_ai_settings WHERE id='site'")).rows[0];
  }
  async function mutate(revision: number, work: (config: Configuration) => Promise<void> | void) {
    await read();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query<Row>("SELECT revision,configuration FROM site_ai_settings WHERE id='site' FOR UPDATE")).rows[0];
      if (row.revision !== revision) throw new AiError('AI settings changed. Refresh before saving.', 409);
      await work(row.configuration);
      row.revision++;
      await client.query("UPDATE site_ai_settings SET revision=$1,configuration=$2,updated_at=now() WHERE id='site'", [row.revision, JSON.stringify(row.configuration)]);
      await client.query('COMMIT');
      return publicSettings(row);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  function credential(provider: StoredProvider) {
    if (!options.encryptionKey) throw new AiError('Configure the server AI encryption key before saving provider credentials.', 503);
    return decryptAiSecret(provider.encryptedCredential, options.encryptionKey, provider.id);
  }
  function find(config: Configuration, id: string) {
    const provider = config.providers.find((item) => item.id === id);
    if (!provider) throw new AiError('AI provider not found', 404);
    return provider;
  }
  return {
    async get() { return publicSettings(await read()); },
    async save(revision: number, id: string, update: AiProviderUpdate) {
      return mutate(revision, (config) => {
        if (!options.encryptionKey) throw new AiError('Configure the server AI encryption key before saving provider credentials.', 503);
        const previous = config.providers.find((item) => item.id === id);
        if (previous && previous.kind !== update.kind) throw new AiError('Create another profile to change the provider type');
        if (!previous && config.providers.length >= 8) throw new AiError('Configure at most eight provider profiles');
        if (!update.name.trim()) throw new AiError('Enter a provider name');
        const changedCredential = Boolean(update.credential);
        const encryptedCredential = changedCredential ? encryptAiSecret(update.credential!.trim(), options.encryptionKey, id) : previous?.encryptedCredential;
        if (!encryptedCredential) throw new AiError('Enter a credential for this provider');
        const models = changedCredential ? [] : previous?.models ?? [];
        if (update.model && !models.some((model) => model.id === update.model)) throw new AiError('Refresh account models and select an available model');
        const modelInfo = models.find((model) => model.id === update.model);
        if (update.allowImages && (modelInfo?.vision === false || !update.supportsImages)) throw new AiError('Select an image-capable model before enabling image sharing');
        const provider: StoredProvider = { id, kind: update.kind, name: update.name.trim(), model: update.model,
          allowImages: update.allowImages, supportsImages: modelInfo?.vision ?? update.supportsImages,
          maxInputChars: update.maxInputChars, maxOutputTokens: update.maxOutputTokens,
          models, modelsUpdatedAt: changedCredential ? null : previous?.modelsUpdatedAt ?? null, encryptedCredential };
        config.providers = [...config.providers.filter((item) => item.id !== id), provider];
        if (config.defaultProviderId === id && !provider.model) config.defaultProviderId = null;
      });
    },
    async refreshModels(revision: number, id: string) {
      return mutate(revision, async (config) => {
        const provider = find(config, id);
        const models = await options.listModels(provider.kind, credential(provider));
        provider.models = models.slice(0, 500);
        provider.modelsUpdatedAt = new Date().toISOString();
        const selected = provider.models.find((model) => model.id === provider.model);
        if (selected?.vision !== null && selected?.vision !== undefined) {
          provider.supportsImages = selected.vision;
          if (!selected.vision) provider.allowImages = false;
        }
        if (!selected) {
          provider.model = null; provider.allowImages = false;
          if (config.defaultProviderId === id) config.defaultProviderId = null;
        }
      });
    },
    async setDefault(revision: number, id: string | null) {
      return mutate(revision, (config) => {
        if (id) { const provider = find(config, id); if (!provider.model || !provider.encryptedCredential) throw new AiError('Select a model before making this provider the default'); }
        config.defaultProviderId = id;
      });
    },
    async remove(revision: number, id: string) {
      return mutate(revision, (config) => {
        find(config, id);
        config.providers = config.providers.filter((item) => item.id !== id);
        if (config.defaultProviderId === id) config.defaultProviderId = null;
      });
    },
    async runtime(id?: string): Promise<AiRuntimeProfile> {
      const row = await read();
      const chosen = id ?? row.configuration.defaultProviderId;
      if (!chosen) throw new AiError('Configure a default provider and model in AI settings first.', 409);
      const provider = find(row.configuration, chosen);
      if (!provider.model) throw new AiError('Select an available model in AI settings first.', 409);
      const profile = publicSettings(row).providers.find((item) => item.id === chosen)!;
      return { ...profile, credential: credential(provider) };
    },
  };
}
export type AiSettingsService = ReturnType<typeof createAiSettingsService>;

export function registerAiSettings(server: FastifyInstance, service: AiSettingsService, auth: ReturnType<typeof createAuth>) {
  const revision = { type: 'integer', minimum: 0 };
  const identifier = { type: 'string', format: 'uuid' };
  const params = { type: 'object', required: ['id'], additionalProperties: false, properties: { id: identifier } };
  const options = { preHandler: auth.operatorOnly };
  server.get('/admin/ai', options, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return service.get();
  });
  const update = { type: 'object', additionalProperties: false,
    required: ['expectedRevision', 'kind', 'name', 'model', 'allowImages', 'supportsImages', 'maxInputChars', 'maxOutputTokens'], properties: {
      expectedRevision: revision, kind: { enum: ['openai', 'copilot'] }, name: { type: 'string', minLength: 1, maxLength: 100 },
      credential: { type: 'string', minLength: 1, maxLength: 4096, pattern: '^\\S+$' }, model: { type: ['string', 'null'], maxLength: 200 },
      allowImages: { type: 'boolean' }, supportsImages: { type: 'boolean' }, maxInputChars: { type: 'integer', minimum: 2000, maximum: 100000 },
      maxOutputTokens: { type: 'integer', minimum: 1000, maximum: 20000 },
    } };
  async function respond(reply: import('fastify').FastifyReply, action: () => Promise<SiteAiSettings>) {
    reply.header('Cache-Control', 'no-store');
    try { return await action(); } catch (error) { return reply.code(error instanceof AiError ? error.status : 503).send({ error: error instanceof AiError ? error.message : 'AI settings could not be updated. Try again.' }); }
  }
  server.put<{ Params: { id: string }; Body: AiProviderUpdate & { expectedRevision: number } }>('/admin/ai/providers/:id', {
    ...options, bodyLimit: 16384, schema: { params, body: update },
  }, (request, reply) => respond(reply, () => service.save(request.body.expectedRevision, request.params.id, request.body)));
  server.post<{ Params: { id: string }; Body: { expectedRevision: number } }>('/admin/ai/providers/:id/models', {
    ...options, schema: { params, body: { type: 'object', additionalProperties: false, required: ['expectedRevision'], properties: { expectedRevision: revision } } },
  }, (request, reply) => respond(reply, () => service.refreshModels(request.body.expectedRevision, request.params.id)));
  server.delete<{ Params: { id: string }; Body: { expectedRevision: number } }>('/admin/ai/providers/:id', {
    ...options, schema: { params, body: { type: 'object', additionalProperties: false, required: ['expectedRevision'], properties: { expectedRevision: revision } } },
  }, (request, reply) => respond(reply, () => service.remove(request.body.expectedRevision, request.params.id)));
  server.put<{ Body: { expectedRevision: number; providerId: string | null } }>('/admin/ai/default', {
    ...options, schema: { body: { type: 'object', additionalProperties: false, required: ['expectedRevision', 'providerId'], properties: { expectedRevision: revision, providerId: { anyOf: [identifier, { type: 'null' }] } } } },
  }, (request, reply) => respond(reply, () => service.setDefault(request.body.expectedRevision, request.body.providerId)));
}