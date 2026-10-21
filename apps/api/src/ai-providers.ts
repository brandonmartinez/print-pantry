import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import { CopilotClient, type SessionConfig } from '@github/copilot-sdk';
import type { AiModel, AiProviderKind } from '@print-pantry/contracts';
import type { AiRuntimeProfile } from './ai-settings.js';
import { AiError } from './ai-secrets.js';

export type AiImage = { name: string; data: string; mimeType: 'image/png' | 'image/jpeg' };
export type AiGeneration = { instructions: string; prompt: string; schema: Record<string, unknown>; images: AiImage[] };
export const suggestionTimeoutMs = 90_000;

export function copilotSuggestionConfig(model: string, maxOutputTokens: number): SessionConfig {
  return { model, availableTools: [], tools: [], enableConfigDiscovery: false,
    skipCustomInstructions: true, enableSkills: false, enableFileHooks: false, enableHostGitOperations: false,
    enableSessionStore: false, enableSessionTelemetry: false, infiniteSessions: { enabled: false }, memory: { enabled: false },
    modelCapabilities: { limits: { max_output_tokens: maxOutputTokens } },
    onPermissionRequest: () => ({ kind: 'reject', feedback: 'Tools are disabled for organization suggestions.' }) };
}

async function withCopilot<Result>(credential: string, action: (client: CopilotClient) => Promise<Result>): Promise<Result> {
  const directory = await mkdtemp(join(tmpdir(), 'pantry-copilot-'));
  const client = new CopilotClient({ mode: 'empty', gitHubToken: credential, useLoggedInUser: false,
    workingDirectory: directory, baseDirectory: directory, logLevel: 'none',
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, COPILOT_GITHUB_TELEMETRY_DISABLED: 'true' } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => { await client.start(); return action(client); })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { void client.forceStop(); reject(new AiError('The AI provider timed out. Your plan is unchanged.', 504)); }, suggestionTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.forceStop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

function providerError(error: unknown, kind: AiProviderKind): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof OpenAI.APIError && error.status === 429) return new AiError('The provider quota or rate limit was reached.', 429);
  if (error instanceof OpenAI.APIError && (error.status === 401 || error.status === 403)) return new AiError('The provider rejected these credentials or account permissions.', 502);
  return new AiError(`${kind === 'openai' ? 'OpenAI' : 'Copilot'} could not complete the request. Check credentials, model access, and provider availability. Your plan is unchanged.`, 502);
}

export async function listAiModels(kind: AiProviderKind, credential: string): Promise<AiModel[]> {
  try {
    if (kind === 'copilot') return await withCopilot(credential, async (client) => (await client.listModels())
      .filter((model) => model.policy?.state !== 'disabled')
      .map((model) => ({ id: model.id, name: model.name, vision: model.capabilities.supports.vision })));
    const client = new OpenAI({ apiKey: credential, maxRetries: 0, timeout: 30_000 });
    const models: AiModel[] = [];
    for await (const model of await client.models.list()) {
      if (!/embedding|whisper|tts|dall-e|sora|audio|realtime|transcrib|moderation/i.test(model.id)) models.push({ id: model.id, name: model.id, vision: null });
      if (models.length >= 500) break;
    }
    return models.sort((first, second) => first.id.localeCompare(second.id));
  } catch (error) { throw providerError(error, kind); }
}

export async function generateAiOrganization(profile: AiRuntimeProfile, input: AiGeneration): Promise<string> {
  if (!profile.model) throw new AiError('Select an AI model first.');
  if (input.prompt.length > profile.maxInputChars) throw new AiError('The selected inventory exceeds this provider input limit. Select fewer projects or increase the limit.');
  if (input.images.length && (!profile.allowImages || !profile.supportsImages)) throw new AiError('Image sharing is not enabled for this model.');
  try {
    if (profile.kind === 'copilot') return await withCopilot(profile.credential, async (client) => {
      const session = await client.createSession({ ...copilotSuggestionConfig(profile.model!, profile.maxOutputTokens), systemMessage: { mode: 'replace', content: input.instructions } });
      try {
        const response = await session.sendAndWait({ prompt: input.prompt, responseSchema: input.schema,
          attachments: input.images.map((image) => ({ type: 'blob' as const, data: image.data, mimeType: image.mimeType, displayName: image.name })) }, suggestionTimeoutMs);
        if (!response?.data.content) throw new AiError('The provider returned no proposal.', 502);
        return response.data.content;
      } finally { await session.disconnect(); }
    });
    const client = new OpenAI({ apiKey: profile.credential, maxRetries: 0, timeout: suggestionTimeoutMs });
    const response = await client.responses.create({ model: profile.model, instructions: input.instructions, store: false,
      max_output_tokens: profile.maxOutputTokens,
      text: { format: { type: 'json_schema', name: 'library_organization', strict: true, schema: input.schema } },
      input: [{ role: 'user', content: [{ type: 'input_text', text: input.prompt }, ...input.images.map((image) => ({
        type: 'input_image' as const, image_url: `data:${image.mimeType};base64,${image.data}`, detail: 'low' as const,
      }))] }] });
    if (response.status !== 'completed' || !response.output_text) throw new AiError('The provider returned an incomplete proposal. Your plan is unchanged.', 502);
    return response.output_text;
  } catch (error) { throw providerError(error, profile.kind); }
}