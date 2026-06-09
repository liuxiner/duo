import test from 'node:test';
import assert from 'node:assert/strict';

import { computeResponsiveLayoutMetrics } from './responsive-layout.mjs';

test('classifies desktop viewport and caps tall panel heights', () => {
  const layout = computeResponsiveLayoutMetrics({ width: 1440, height: 900 });

  assert.equal(layout.widthTier, 'desktop');
  assert.equal(layout.heightTier, 'regular');
  assert.equal(layout.cssVars['--table-max-height'], '560px');
  assert.equal(layout.cssVars['--log-max-height'], '360px');
  assert.equal(layout.cssVars['--modal-max-height'], '860px');
});

test('classifies compact mobile viewport and preserves minimum scroll areas', () => {
  const layout = computeResponsiveLayoutMetrics({ width: 640, height: 620 });

  assert.equal(layout.widthTier, 'mobile');
  assert.equal(layout.heightTier, 'short');
  assert.equal(layout.cssVars['--table-max-height'], '220px');
  assert.equal(layout.cssVars['--log-max-height'], '190px');
  assert.equal(layout.cssVars['--log-preview-max-height'], '96px');
  assert.equal(layout.cssVars['--modal-max-height'], '604px');
});
