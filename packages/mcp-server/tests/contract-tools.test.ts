/**
 * The floor this source serves is the floor `contract-tools.json` lists —
 * the tools C4 §11 says ship in the next release. The release check makes
 * the same comparison on the packed install (C4 §7 rule 7); this test makes
 * it on every pull request, so a tool registered without a contract row
 * fails here and not on the day of the release.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { buildServer } from '../src/server.js';

const contract = JSON.parse(readFileSync(resolve(__dirname, '..', 'contract-tools.json'), 'utf8')) as {
  contract: string;
  contractVersion: string;
  floor: string[];
};

describe('contract-tools.json', () => {
  it('lists exactly the floor tools this source registers', () => {
    const server = buildServer();
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(names).toEqual([...contract.floor].sort());
  });
});
