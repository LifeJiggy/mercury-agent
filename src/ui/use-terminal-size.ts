import React from 'react';
import { useStdout } from 'ink';

/**
 * Live terminal size. Listens to stdout resize and polls as a fallback — some
 * terminal/pty setups (remote-desktop sessions, multiplexers) don't deliver
 * the resize event when the window changes, and a stale size breaks any
 * explicit-width layout.
 */
export function useTerminalSize(): { rows: number; cols: number } {
  const { stdout } = useStdout();
  const [size, setSize] = React.useState({ rows: stdout.rows || 24, cols: stdout.columns || 80 });
  React.useEffect(() => {
    const onResize = () => {
      const rows = stdout.rows || 24;
      const cols = stdout.columns || 80;
      setSize((current) => current.rows === rows && current.cols === cols ? current : { rows, cols });
    };
    stdout.on('resize', onResize);
    const fallback = setInterval(onResize, 500);
    fallback.unref?.();
    return () => {
      stdout.off('resize', onResize);
      clearInterval(fallback);
    };
  }, [stdout]);
  return size;
}