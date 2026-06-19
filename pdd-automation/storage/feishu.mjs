export async function writeAppointmentRowsToFeishu({
  cfg,
  headers,
  rows,
  writeToFeishu,
  fallbackCsv = '',
}) {
  if (typeof writeToFeishu !== 'function') {
    throw new Error('Feishu writer is not configured.');
  }
  try {
    await writeToFeishu(cfg, headers, rows);
    return { ok: true, fallback: false };
  } catch (error) {
    if (cfg?.feishuStrictWrite) throw error;
    console.error(`Feishu write failed: ${error.message || error}`);
    if (fallbackCsv) {
      console.log(`Using local Feishu-compatible fallback CSV: ${fallbackCsv}`);
    }
    return {
      ok: false,
      fallback: true,
      fallbackCsv,
      error,
    };
  }
}
