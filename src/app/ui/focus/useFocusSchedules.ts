'use client';

/**
 * 专注日程的客户端状态。
 *
 * ★ 只有这一个数据入口：列表、当前安排、增删改都走 `/api/focus/*`。
 *   它不读取 `useSessionIndex`，也不碰 `/api/tasks` —— 两条数据链互不可见。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage, fetchJson, patchJson, postJson } from '../lib/api.js';
import type { FocusScheduleDto, FocusSchedulesResponse } from '../lib/types.js';

export interface FocusScheduleDraft {
  readonly title: string;
  readonly note: string;
  readonly startAt: number;
  readonly endAt: number;
  readonly remind: boolean;
}

export interface FocusSchedulesValue {
  readonly schedules: readonly FocusScheduleDto[];
  readonly currentId: string | null;
  readonly current: FocusScheduleDto | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly reload: () => Promise<void>;
  readonly create: (draft: FocusScheduleDraft) => Promise<void>;
  readonly update: (id: string, draft: FocusScheduleDraft) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly setCurrent: (id: string) => Promise<void>;
}

export function useFocusSchedules(): FocusSchedulesValue {
  const [schedules, setSchedules] = useState<readonly FocusScheduleDto[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const apply = useCallback((res: FocusSchedulesResponse): void => {
    setSchedules(res.schedules);
    setCurrentId(res.currentId);
    setError(null);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setLoading(true);
    try {
      const res = await fetchJson<FocusSchedulesResponse>('/api/focus/schedules');
      if (seq !== seqRef.current) return;
      apply(res);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(errorMessage(err));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [apply]);

  useEffect(() => {
    void reload();
    return () => {
      seqRef.current += 1;
    };
  }, [reload]);

  const create = useCallback(
    async (draft: FocusScheduleDraft): Promise<void> => {
      // 任何写操作都让在途的读请求作废，避免旧列表回包覆盖刚保存的结果。
      seqRef.current += 1;
      const res = await postJson<FocusSchedulesResponse>('/api/focus/schedules', draft);
      apply(res);
      setLoading(false);
    },
    [apply],
  );

  const update = useCallback(
    async (id: string, draft: FocusScheduleDraft): Promise<void> => {
      seqRef.current += 1;
      const res = await patchJson<FocusSchedulesResponse>(
        `/api/focus/schedules/${encodeURIComponent(id)}`,
        draft,
      );
      apply(res);
      setLoading(false);
    },
    [apply],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      seqRef.current += 1;
      const res = await fetchJson<FocusSchedulesResponse>(
        `/api/focus/schedules/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      apply(res);
      setLoading(false);
    },
    [apply],
  );

  const setCurrent = useCallback(
    async (id: string): Promise<void> => {
      seqRef.current += 1;
      const res = await postJson<FocusSchedulesResponse>('/api/focus/current', { id });
      apply(res);
      setLoading(false);
    },
    [apply],
  );

  const current = useMemo(
    () => schedules.find((schedule) => schedule.id === currentId) ?? null,
    [currentId, schedules],
  );

  return {
    schedules,
    currentId,
    current,
    loading,
    error,
    reload,
    create,
    update,
    remove,
    setCurrent,
  };
}
