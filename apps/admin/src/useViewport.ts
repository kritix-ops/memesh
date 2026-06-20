import { useEffect, useState } from 'react';

const getWidth = (): number => (typeof window === 'undefined' ? 1024 : window.innerWidth);

// Single source of truth for responsive breakpoints. The app is inline-styled,
// so layouts branch on this rather than CSS media queries.
export function useViewport() {
  const [width, setWidth] = useState<number>(getWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return { width, isMobile: width < 768, isTablet: width >= 768 && width < 1024 };
}
