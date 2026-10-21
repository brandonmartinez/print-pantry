import { expect, it } from 'vitest';
import type { LegacyImportProject } from '@print-pantry/contracts';
import { validateOrganization, organizationImages, organizationInstructions } from './ai-organization.js';

const project: LegacyImportProject = { key: 'project', sourcePath: 'Tools', name: 'Holder', category: null, linked: false, status: 'planned', directories: [], blockers: [], warnings: [], files: [
  { id: 'first', path: 'models/one.stl', originalPath: 'one.STL', size: 12, hash: null },
  { id: 'second', path: 'models/two.stl', originalPath: 'two.STL', size: 12, hash: null },
] };
const proposal = () => ({ projects: [{ key: 'project', name: 'Desk holder', category: 'Tools/Desk', paths: project.files.map(({ id, path }) => ({ id, path })) }] });
it('instructs minimal filename cleanup within the canonical filing layout', () => {
  for (const rule of [
    'Prioritize filename sanitization. Keep valid names and destinations unchanged.',
    'use only models/', 'images/ (independent images)', 'docs/ (documentation and unclassified support files)', 'exports/ (printer/machine output)',
    'Root files are limited to recognized README', 'source.url or *.webloc', 'docs/source-project.json',
    'Do not invent archive, links or format-only folders.',
    'Leave uncertain files at their current destinations.',
    'For linked projects or preserve layout, retain every destination path exactly; this overrides all renaming/filing advice.',
    'Return every project key and file ID exactly once, including unchanged files.',
  ]) expect(organizationInstructions).toContain(rule);
});
it('validates a complete proposal without mutating the current plan', () => {
  expect(validateOrganization(JSON.stringify(proposal()), [project], false)[0].name).toBe('Desk holder');
  expect(project.name).toBe('Holder');
});
it('rejects omitted files, invented identities, unsafe paths and collisions', () => {
  for (const path of ['../outside.stl', 'models/one.stl', 'models/new.exe', 'project.json']) {
    const value = proposal(); value.projects[0].paths[1].path = path;
    expect(() => validateOrganization(JSON.stringify(value), [project], false)).toThrow();
  }
  const missing = proposal(); missing.projects[0].paths.pop();
  expect(() => validateOrganization(JSON.stringify(missing), [project], false)).toThrow('every file');
  const invented = proposal(); invented.projects[0].paths[0].id = 'invented';
  expect(() => validateOrganization(JSON.stringify(invented), [project], false)).toThrow('identities');
  expect(() => validateOrganization('not JSON', [project], false)).toThrow('JSON');
});
it('preserves linked resources and explicit keep-layout choices', () => {
  const value = proposal(); value.projects[0].paths[0].path = 'models/renamed.stl';
  expect(() => validateOrganization(JSON.stringify(value), [{ ...project, linked: true }], false)).toThrow('protected');
  expect(() => validateOrganization(JSON.stringify(value), [project], true)).toThrow('protected');
});
it('rejects non-images and unrelated render identities', () => {
  expect(() => organizationImages([{ fileId: 'first', data: Buffer.from('not png').toString('base64') }], [project])).toThrow();
  expect(() => organizationImages([{ fileId: 'outside', data: 'abcd' }], [project])).toThrow();
});