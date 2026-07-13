// React binding for the content registry. Wrap an app in <ContentProvider> and
// call useContent().t(key, vars) anywhere. The provider fetches the merged map
// (/content) once on boot; t() falls back to the bundled registry default for
// any key the fetch didn't return (or if the fetch failed), so the UI never
// shows a blank label. Lives in the './react' subpath so the Node API can
// import the registry without pulling in React.

import { apiRequest, type ApiAudience } from '@memesh/web-shared';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { resolveContent, type ContentMap } from './index';

export interface ContentContextValue {
  /** Resolve a key to its effective text, interpolating {{vars}} if given. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** False until the first /content fetch settles (success or failure). */
  loaded: boolean;
}

// Used when a component calls useContent() outside any provider — t() still
// works off the bundled defaults, so nothing crashes or renders empty.
const FALLBACK: ContentContextValue = {
  loaded: true,
  t: (key, vars) => resolveContent({}, key, vars),
};

const ContentContext = createContext<ContentContextValue | null>(null);

export function ContentProvider({
  audience = 'customer',
  children,
}: {
  audience?: ApiAudience;
  children: ReactNode;
}) {
  const [map, setMap] = useState<ContentMap>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await apiRequest<{ content: ContentMap }>('/content', { audience });
      if (cancelled) return;
      if (res.ok) {
        setMap(res.data.content);
      } else {
        // Keep the empty map — t() falls back to bundled defaults. Log so a
        // silent /content outage is diagnosable.
        console.warn('[content boot] load failed', { status: res.status, error: res.error });
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [audience]);

  const value = useMemo<ContentContextValue>(
    () => ({ loaded, t: (key, vars) => resolveContent(map, key, vars) }),
    [map, loaded],
  );

  return <ContentContext.Provider value={value}>{children}</ContentContext.Provider>;
}

export function useContent(): ContentContextValue {
  return useContext(ContentContext) ?? FALLBACK;
}
