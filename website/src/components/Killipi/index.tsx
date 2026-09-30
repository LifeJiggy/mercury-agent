import React from 'react';
import KillipiGlyph from './KillipiGlyph';
// V2.5 living glyph (orbtal rings + expression state machine + demo sync).
// The legacy v1 mascot component is retired; its classes only remain in
// styles.css for old builds. styles.css is no longer imported here.

export default function Killipi(): React.ReactElement {
  return <KillipiGlyph />;
}