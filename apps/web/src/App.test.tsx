import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';

afterEach(() => vi.unstubAllGlobals());

it('shows a connected shell when the API and database are ready', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ready' }) }));
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Print Pantry' })).toBeTruthy();
  expect(await screen.findByText('API: Connected')).toBeTruthy();
});

it('shows an actionable offline state', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network offline')));
  render(<App />);
  expect(await screen.findByText('API: Service unavailable')).toBeTruthy();
});
