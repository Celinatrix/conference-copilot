'use client';

import { useEffect, useState } from 'react';

/** A number kept in localStorage per browser (e.g. the reading font size). Falls back silently when storage is blocked. */
export function usePersistentNumber(key: string, initial: number) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (v) setValue(v);
    } catch {}
  }, [key]);
  const update = (v: number) => {
    setValue(v);
    try {
      localStorage.setItem(key, String(v));
    } catch {}
  };
  return [value, update] as const;
}
