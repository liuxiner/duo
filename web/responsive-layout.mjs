function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeViewport(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

export function computeResponsiveLayoutMetrics({ width, height }) {
  const viewportWidth = normalizeViewport(width, 1280);
  const viewportHeight = normalizeViewport(height, 800);
  const widthTier = viewportWidth <= 680
    ? 'mobile'
    : viewportWidth <= 860
      ? 'stacked'
      : viewportWidth <= 1120
        ? 'compact'
        : 'desktop';
  const heightTier = viewportHeight < 760 ? 'short' : 'regular';
  const tableOffset = widthTier === 'mobile' ? 400 : widthTier === 'stacked' ? 360 : 320;
  const logOffset = widthTier === 'mobile' ? 430 : heightTier === 'short' ? 500 : 520;
  const modalPadding = widthTier === 'mobile' ? 16 : 40;
  const tableMaxHeight = clamp(viewportHeight - tableOffset, 220, 560);
  const logMaxHeight = clamp(viewportHeight - logOffset, 190, 360);
  const logPreviewMaxHeight = clamp(Math.round(logMaxHeight * 0.5), 96, 160);
  const modalMaxHeight = Math.max(viewportHeight - modalPadding, 260);

  return {
    widthTier,
    heightTier,
    cssVars: {
      '--app-height': `${viewportHeight}px`,
      '--table-max-height': `${tableMaxHeight}px`,
      '--log-max-height': `${logMaxHeight}px`,
      '--log-preview-max-height': `${logPreviewMaxHeight}px`,
      '--modal-max-height': `${modalMaxHeight}px`,
    },
  };
}

export function applyResponsiveLayout(documentRef, viewport) {
  const metrics = computeResponsiveLayoutMetrics(viewport);
  Object.entries(metrics.cssVars).forEach(([name, value]) => {
    documentRef.documentElement.style.setProperty(name, value);
  });
  if (documentRef.body) {
    documentRef.body.dataset.widthTier = metrics.widthTier;
    documentRef.body.dataset.heightTier = metrics.heightTier;
  }
  return metrics;
}

export function createResponsiveLayoutController({ window: windowRef, document: documentRef }) {
  let frameId = 0;
  let lastMetrics = null;

  const apply = () => {
    lastMetrics = applyResponsiveLayout(documentRef, {
      width: windowRef.innerWidth,
      height: windowRef.innerHeight,
    });
    return lastMetrics;
  };

  const onResize = () => {
    if (frameId) return;
    frameId = windowRef.requestAnimationFrame(() => {
      frameId = 0;
      apply();
    });
  };

  apply();
  windowRef.addEventListener('resize', onResize, { passive: true });

  return {
    apply,
    destroy() {
      if (frameId) windowRef.cancelAnimationFrame(frameId);
      windowRef.removeEventListener('resize', onResize);
    },
    getMetrics() {
      return lastMetrics;
    },
  };
}
