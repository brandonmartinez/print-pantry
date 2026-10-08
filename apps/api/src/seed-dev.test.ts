import { describe, expect, it } from 'vitest';
import { isLocalDevelopmentDatabase } from './seed-dev.js';

describe('local development account seeding guard', () => {
  it('accepts the Compose development database', () => {
    expect(isLocalDevelopmentDatabase('postgresql://pantry:dev@db:5432/print_pantry_dev')).toBe(true);
  });

  it('rejects non-local hosts and non-development databases', () => {
    expect(isLocalDevelopmentDatabase('postgresql://app:secret@db.example.com:5432/print_pantry_dev')).toBe(false);
    expect(isLocalDevelopmentDatabase('postgresql://pantry:dev@db:5432/print_pantry_prod')).toBe(false);
    expect(isLocalDevelopmentDatabase('not a database URL')).toBe(false);
  });
});
