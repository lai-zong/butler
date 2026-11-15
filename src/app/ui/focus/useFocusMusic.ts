'use client';

/**
 * 专注空间的本地音乐。
 *
 * ★ 只播放用户当场选择的本地音频；不接在线音乐，也不读取系统播放器。
 * ★ 曲目与 object URL 只活在本次专注空间挂载期间：
 *   退出专注（组件卸载）即停止并释放，符合「只保证当前会话」。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

const MAX_TRACKS = 12;
const MAX_TRACK_BYTES = 80 * 1024 * 1024;

export interface FocusTrack {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly url: string;
}

export interface FocusMusicValue {
  readonly tracks: readonly FocusTrack[];
  readonly current: FocusTrack | null;
  readonly currentId: string | null;
  readonly playing: boolean;
  readonly volume: number;
  readonly loop: boolean;
  readonly error: string | null;
  readonly audioRef: RefObject<HTMLAudioElement>;
  readonly addFiles: (files: readonly File[]) => Promise<void>;
  readonly toggleTrack: (id: string) => void;
  readonly togglePlay: () => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly remove: (id: string) => void;
  readonly setVolume: (value: number) => void;
  readonly setLoop: (value: boolean) => void;
  readonly handleEnded: () => void;
}

function trackId(): string {
  return `track_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function useFocusMusic(): FocusMusicValue {
  const [tracks, setTracks] = useState<readonly FocusTrack[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolumeState] = useState(0.7);
  const [loop, setLoop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const urlsRef = useRef<Set<string>>(new Set());
  const tracksRef = useRef<readonly FocusTrack[]>([]);

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  const current = tracks.find((track) => track.id === currentId) ?? null;

  // 音源变化或播放状态变化时，真正操控 <audio>。
  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    audio.volume = volume;
  }, [volume, currentId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null || current === null) return;
    if (playing) {
      if (audio.ended) audio.currentTime = 0;
      void audio.play().catch(() => {
        setPlaying(false);
        setError('浏览器没有允许自动播放，请再点一次播放');
      });
    } else {
      audio.pause();
    }
  }, [current, playing]);

  useEffect(() => {
    return () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    };
  }, []);

  const addFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    const audios = files.filter(
      (file) =>
        file.type.startsWith('audio/') ||
        /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(file.name),
    );
    if (audios.length === 0) throw new Error('请选择音频文件');
    if (audios.some((file) => file.size > MAX_TRACK_BYTES)) {
      throw new Error('单个音频不能超过 80 MB');
    }
    const room = MAX_TRACKS - tracksRef.current.length;
    if (room <= 0) throw new Error(`最多同时保留 ${MAX_TRACKS} 首本地音乐`);
    const accepted = audios.slice(0, room);
    const created: FocusTrack[] = accepted.map((file) => {
      const url = URL.createObjectURL(file);
      urlsRef.current.add(url);
      return { id: trackId(), name: file.name.replace(/\.[^.]+$/u, ''), size: file.size, url };
    });
    const nextTracks = [...tracksRef.current, ...created];
    tracksRef.current = nextTracks;
    setTracks(nextTracks);
    if (currentId === null && created[0] !== undefined) setCurrentId(created[0].id);
    setError(null);
  }, [currentId]);

  const toggleTrack = useCallback(
    (id: string): void => {
      if (currentId === id) {
        setPlaying((prev) => !prev);
      } else {
        setCurrentId(id);
        setPlaying(true);
      }
      setError(null);
    },
    [currentId],
  );

  const togglePlay = useCallback((): void => {
    if (currentId === null) {
      const first = tracksRef.current[0];
      if (first === undefined) return;
      setCurrentId(first.id);
      setPlaying(true);
      return;
    }
    setPlaying((prev) => !prev);
    setError(null);
  }, [currentId]);

  const move = useCallback(
    (offset: number): void => {
      const list = tracksRef.current;
      if (list.length === 0) return;
      const index = list.findIndex((track) => track.id === currentId);
      const nextIndex = index < 0 ? 0 : (index + offset + list.length) % list.length;
      const target = list[nextIndex];
      if (target === undefined) return;
      setCurrentId(target.id);
      setError(null);
    },
    [currentId],
  );

  const next = useCallback((): void => move(1), [move]);
  const previous = useCallback((): void => move(-1), [move]);

  const remove = useCallback(
    (id: string): void => {
      const target = tracksRef.current.find((track) => track.id === id);
      if (target !== undefined) {
        URL.revokeObjectURL(target.url);
        urlsRef.current.delete(target.url);
      }
      const remaining = tracksRef.current.filter((track) => track.id !== id);
      tracksRef.current = remaining;
      setTracks(remaining);
      if (currentId === id) {
        setCurrentId(remaining[0]?.id ?? null);
        if (remaining.length === 0) setPlaying(false);
      }
      setError(null);
    },
    [currentId],
  );

  const setVolume = useCallback((value: number): void => {
    setVolumeState(Math.min(1, Math.max(0, value)));
  }, []);

  const handleEnded = useCallback((): void => {
    if (loop) {
      const audio = audioRef.current;
      if (audio !== null) {
        audio.currentTime = 0;
        void audio.play().catch(() => setPlaying(false));
      }
      return;
    }
    const list = tracksRef.current;
    if (list.length <= 1) {
      setPlaying(false);
      return;
    }
    move(1);
  }, [loop, move]);

  return {
    tracks,
    current,
    currentId,
    playing,
    volume,
    loop,
    error,
    audioRef,
    addFiles,
    toggleTrack,
    togglePlay,
    next,
    previous,
    remove,
    setVolume,
    setLoop,
    handleEnded,
  };
}
