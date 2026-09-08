import { useCallback, useEffect, useRef } from "react";

export function useAutosave(input: {
  dirty: boolean;
  paused: boolean;
  signature: string;
  save: () => void;
}) {
  const save = useRef(input.save),
    attempted = useRef<string | null>(null);
  useEffect(() => {
    save.current = input.save;
  }, [input.save]);
  useEffect(() => {
    if (!input.dirty) {
      attempted.current = null;
      return;
    }
    if (input.paused || attempted.current === input.signature) return;
    const timer = window.setTimeout(() => {
      attempted.current = input.signature;
      save.current();
    }, 600);
    return () => window.clearTimeout(timer);
  }, [input.dirty, input.paused, input.signature]);
}

export function useSaveIdentity() {
  const last = useRef<{ key: string; id: string } | null>(null);
  return useCallback((value: unknown) => {
    const key = JSON.stringify(value);
    if (last.current?.key !== key)
      last.current = { key, id: crypto.randomUUID() };
    return last.current.id;
  }, []);
}
