import { collectAppointmentViaApi } from '../scrapers/appointment-api.mjs';
import { collectAppointmentViaUi } from '../scrapers/appointment-ui.mjs';

export async function collectAppointmentPayload({
  cfg,
  context,
  collectViaUi,
  collectViaApiOptions = {},
}) {
  if (cfg.syncMode === 'api') {
    return collectAppointmentViaApi(cfg, context, collectViaApiOptions);
  }

  if (cfg.syncMode === 'auto') {
    try {
      return await collectAppointmentViaApi(cfg, context, collectViaApiOptions);
    } catch (apiError) {
      console.warn(`PDD API sync failed, falling back to DOM collection: ${apiError.message || apiError}`);
      return collectAppointmentViaUi(cfg, context, { collectViaUi });
    }
  }

  return collectAppointmentViaUi(cfg, context, { collectViaUi });
}
