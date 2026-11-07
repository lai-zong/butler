import { describe, expect, it } from 'vitest';

import {
  parsePetFocusPayload,
  petFocusOriginChanged,
  withSessionParam,
  type PendingPetFocus,
} from '../petFocus.js';

const pending: PendingPetFocus = {
  sessionId: 's_2',
  seq: 1,
  originSessionId: 's_1',
  fromBeforeBoot: false,
};

describe('parsePetFocusPayload', () => {
  it('accepts a pending focus request', () => {
    expect(
      parsePetFocusPayload({
        ok: true,
        focus: { sessionId: 's_2', requestedAt: 1_700_000_000_000 },
      }),
    ).toEqual({ sessionId: 's_2', requestedAt: 1_700_000_000_000 });
  });

  it('treats null focus as no request', () => {
    expect(parsePetFocusPayload({ ok: true, focus: null })).toBeNull();
  });

  it('rejects malformed payloads instead of throwing', () => {
    expect(parsePetFocusPayload(null)).toBeNull();
    expect(parsePetFocusPayload('oops')).toBeNull();
    expect(parsePetFocusPayload({ ok: false, focus: { sessionId: 's_1' } })).toBeNull();
    expect(parsePetFocusPayload({ ok: true, focus: { sessionId: '   ' } })).toBeNull();
    expect(parsePetFocusPayload({ ok: true, focus: { sessionId: 42 } })).toBeNull();
  });

  it('defaults a missing timestamp but keeps the session id', () => {
    expect(parsePetFocusPayload({ ok: true, focus: { sessionId: ' s_3 ' } })).toEqual({
      sessionId: 's_3',
      requestedAt: 0,
    });
  });
});

describe('petFocusOriginChanged', () => {
  it('keeps the request while the user stays in the same session', () => {
    expect(petFocusOriginChanged(pending, 's_1')).toBe(false);
  });

  it('drops the request after the user switches away', () => {
    expect(petFocusOriginChanged(pending, 's_9')).toBe(true);
    expect(petFocusOriginChanged(pending, null)).toBe(true);
  });

  it('does not treat a pre-boot request as a user switch', () => {
    expect(petFocusOriginChanged({ ...pending, originSessionId: null, fromBeforeBoot: true }, 's_1')).toBe(
      false,
    );
  });
});

describe('withSessionParam', () => {
  it('replaces an existing session id and keeps the hash', () => {
    expect(withSessionParam('http://127.0.0.1:3210/?session=A#/chat', 'B')).toBe(
      '/?session=B#/chat',
    );
  });

  it('adds the session id while preserving other query params and the hash', () => {
    expect(withSessionParam('http://127.0.0.1:3210/?x=1#/chat', 'B')).toBe(
      '/?x=1&session=B#/chat',
    );
  });

  it('keeps a hash without a query string intact', () => {
    expect(withSessionParam('http://127.0.0.1:3210/#/chat', 'B')).toBe('/?session=B#/chat');
  });
});
