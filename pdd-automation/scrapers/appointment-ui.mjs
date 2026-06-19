export async function collectAppointmentViaUi(cfg, context, { collectViaUi } = {}) {
  if (typeof collectViaUi !== 'function') {
    throw new Error('UI appointment collector is not configured.');
  }
  return collectViaUi(cfg, context);
}
