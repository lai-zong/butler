import { afterEach, describe, expect, it } from 'vitest';

import {
  clearPetFocus,
  PET_FOCUS_TTL_MS,
  requestPetFocus,
  takePetFocus,
} from '../petFocus.js';

afterEach(() => {
  clearPetFocus();
});

describe('pet focus queue', () => {
  it('returns the pending focus once', () => {
    requestPetFocus('s_1', 1000);
    expect(takePetFocus(1001)).toEqual({ sessionId: 's_1', requestedAt: 1000 });
    expect(takePetFocus(1002)).toBeNull();
  });

  it('replaces an older request with the latest one', () => {
    requestPetFocus('s_1', 1000);
    requestPetFocus('s_2', 1001);
    expect(takePetFocus(1002)?.sessionId).toBe('s_2');
  });

  it('drops expired requests', () => {
    requestPetFocus('s_1', 1000);
    expect(takePetFocus(1000 + PET_FOCUS_TTL_MS + 1)).toBeNull();
  });
});
