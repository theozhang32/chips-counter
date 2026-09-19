import cron from 'node-cron';

// §7.6：启动后延迟 30s 首跑，此后每小时整点（0 * * * *）
export function createRetentionJob({ retentionService, logger }) {
  let task = null;
  let firstRunTimer = null;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await retentionService.runOnce();
    } catch (err) {
      logger.error('retention job failed', { error: err });
    } finally {
      running = false;
    }
  };

  return {
    start() {
      firstRunTimer = setTimeout(run, 30_000);
      firstRunTimer.unref?.();
      task = cron.schedule('0 * * * *', run);
    },
    stop() {
      if (firstRunTimer) clearTimeout(firstRunTimer);
      task?.stop();
    },
  };
}
