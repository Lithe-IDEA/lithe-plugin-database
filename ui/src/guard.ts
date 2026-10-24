// Writes on a connection with production protection: the backend refuses
// them with `confirmation_required` until the user confirms, and the page
// then repeats the request with `confirmed: true`. The backend decides what
// needs confirmation, so the page cannot skip it.
import { errorCode } from './bridge.ts';
import { t } from './i18n.ts';
import { confirm } from './store.ts';

export async function withConfirmation<T>(
  run: (confirmed: boolean) => Promise<T>,
  describe: { title: string; message: string; confirmLabel?: string },
  alreadyConfirmed = false,
): Promise<T | undefined> {
  try {
    return await run(alreadyConfirmed);
  } catch (error) {
    if (alreadyConfirmed || errorCode(error) !== 'confirmation_required') throw error;
    const ok = await confirm({
      title: describe.title,
      message: `${describe.message}\n\n${t('This connection is marked as production.')}`,
      confirmLabel: describe.confirmLabel ?? t('Run'),
      destructive: true,
    });
    return ok ? run(true) : undefined;
  }
}
