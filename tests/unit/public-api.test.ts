/**
 * Public runtime-surface snapshot guard (plans/sdk-parity-typescript.md
 * Phase 3) — the TS analogue of Python's test_public_api.py. Catches an
 * accidental new or removed *runtime* export before it reaches a published
 * release. Type-only exports are invisible here (`Object.keys` sees runtime
 * values only, the same limitation `vars(macp_sdk)` has in Python) — this
 * guards the value surface, not the type surface.
 */
import { describe, expect, it } from 'vitest';
import * as sdk from '../../src/index';
import snapshot from './public-api-snapshot.json';

describe('public API runtime surface', () => {
  it('matches the committed snapshot', () => {
    const actual = Object.keys(sdk)
      .filter((key) => key !== 'default')
      .sort();
    expect(
      actual,
      'Public runtime export surface changed. If this change is intentional, update tests/unit/public-api-snapshot.json in the same commit.',
    ).toEqual(snapshot);
  });
});
