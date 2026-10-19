import { createHash } from 'node:crypto';
import type { ImportSource } from '@print-pantry/contracts';

export class InvalidSourceUrlError extends Error {}

export function importSource(input: string): ImportSource {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InvalidSourceUrlError('Enter a complete http or https source URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !url.hostname || url.href.length > 2048) {
    throw new InvalidSourceUrlError('Source URL must use http or https, without embedded credentials, and be at most 2048 characters');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let provider: ImportSource['provider'] = 'other';
  let modelId: string | null = null;
  let profileId: string | null = null;
  let canonicalUrl = url.href;
  if ((!url.port || url.port === '443' || url.port === '80') && host === 'makerworld.com') {
    provider = 'makerworld';
    modelId = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?models\/([1-9][0-9]*)(?:-|\/|$)/i)?.[1] ?? null;
    profileId = url.hash.match(/^#profileId-([1-9][0-9]*)$/i)?.[1] ??
      (/^[1-9][0-9]*$/.test(url.searchParams.get('profileId') ?? '') ? url.searchParams.get('profileId') : null);
    if (modelId) canonicalUrl = `https://makerworld.com/en/models/${modelId}`;
  } else if (!url.port && host === 'thingiverse.com') {
    provider = 'thingiverse';
    modelId = url.pathname.match(/^\/thing:([1-9][0-9]*)\/?$/)?.[1] ?? null;
    if (modelId) canonicalUrl = `https://www.thingiverse.com/thing:${modelId}`;
  } else if (!url.port && host === 'printables.com') {
    provider = 'printables';
    modelId = url.pathname.match(/^\/(?:[a-z]{2}\/)?model\/([1-9][0-9]*)(?:-|\/|$)/i)?.[1] ?? null;
    if (modelId) canonicalUrl = `https://www.printables.com/model/${modelId}`;
  } else if (!url.port && host === 'thangs.com') {
    provider = 'thangs';
    modelId = url.pathname.match(/^\/m\/([1-9][0-9]*)\/?$/)?.[1] ??
      url.pathname.match(/^\/designer\/[^/]+\/3d-model\/[^/]+-([1-9][0-9]*)\/?$/)?.[1] ?? null;
    if (modelId) canonicalUrl = `https://thangs.com/m/${modelId}`;
  }
  return {
    url: url.href, canonicalUrl, provider, modelId, profileId,
    key: modelId ? `${provider}:model:${modelId}` :
      `url:${createHash('sha256').update(canonicalUrl).digest('hex')}`,
  };
}
