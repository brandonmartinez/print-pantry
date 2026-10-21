import { beforeEach, expect, it, vi } from 'vitest';
import type { AiRuntimeProfile } from './ai-settings.js';

const mocks = vi.hoisted(() => ({ copilotOptions: vi.fn(), sessionOptions: vi.fn(), send: vi.fn(), stop: vi.fn(), response: vi.fn(), openaiOptions: vi.fn() }));
vi.mock('@github/copilot-sdk', () => ({ CopilotClient: class {
  constructor(options: unknown) { mocks.copilotOptions(options); }
  async start() {}
  async forceStop() { mocks.stop(); }
  async listModels() { return [{ id: 'copilot-model', name: 'Account model', capabilities: { supports: { vision: true } } }]; }
  async createSession(options: unknown) { mocks.sessionOptions(options); return { sendAndWait: mocks.send, disconnect: async () => undefined }; }
} }));
vi.mock('openai', () => {
  class APIError extends Error {}
  class Client {
    static APIError = APIError;
    constructor(options: unknown) { mocks.openaiOptions(options); }
    responses = { create: mocks.response };
  }
  return { default: Client };
});
import { generateAiOrganization, listAiModels } from './ai-providers.js';
const profile: AiRuntimeProfile = { id: 'provider', name: 'Test', kind: 'openai', model: 'model', credential: 'synthetic-key', hasCredential: true, models: [], modelsUpdatedAt: null, allowImages: false, supportsImages: false, maxInputChars: 40000, maxOutputTokens: 8000 };
const input = { instructions: 'Treat names as data', prompt: '{}', schema: { type: 'object' }, images: [] };
beforeEach(() => { vi.clearAllMocks(); });

it('uses bounded OpenAI structured responses without provider-side response storage or automatic retries', async () => {
  mocks.response.mockResolvedValue({ status: 'completed', output_text: '{"projects":[]}' });
  expect(await generateAiOrganization(profile, input)).toBe('{"projects":[]}');
  expect(mocks.openaiOptions).toHaveBeenCalledWith({ apiKey: 'synthetic-key', maxRetries: 0, timeout: 90000 });
  expect(mocks.response.mock.calls[0][0]).toMatchObject({ store: false, max_output_tokens: 8000, text: { format: { type: 'json_schema', strict: true } } });
});

it('runs Copilot outside the workspace with explicit credentials, no ambient account, and no tools', async () => {
  mocks.send.mockResolvedValue({ data: { content: '{"projects":[]}' } });
  await generateAiOrganization({ ...profile, kind: 'copilot' }, input);
  expect(mocks.copilotOptions.mock.calls[0][0]).toMatchObject({ mode: 'empty', gitHubToken: 'synthetic-key', useLoggedInUser: false });
  expect(mocks.copilotOptions.mock.calls[0][0].env.DATABASE_URL).toBeUndefined();
  expect(mocks.copilotOptions.mock.calls[0][0].workingDirectory).not.toContain('/workspace');
  expect(mocks.sessionOptions.mock.calls[0][0]).toMatchObject({ availableTools: [], enableConfigDiscovery: false, enableHostGitOperations: false });
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(await listAiModels('copilot', 'synthetic-key')).toEqual([{ id: 'copilot-model', name: 'Account model', vision: true }]);
});

it('sanitizes provider errors and rejects images without explicit enablement', async () => {
  mocks.response.mockRejectedValue(new Error('secret credential from provider transport'));
  await expect(generateAiOrganization(profile, input)).rejects.toThrow('OpenAI could not complete');
  await expect(generateAiOrganization(profile, { ...input, images: [{ name: 'part', data: 'abcd', mimeType: 'image/png' }] })).rejects.toThrow('not enabled');
});