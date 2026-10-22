import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import type { ApplyOptions, ApplyResult, JournalEntry, Plan, TransactionJournal } from '../model.js';
import { snapshotPath, snapshotsEqual } from './snapshot.js';
import {
  acquireLock, checkCancellation, checkExpected, cleanupStages, createStage, finding,
  initializeStorage, mutate, newEffects, operationChanges, persistJournal, prepareOperation,
  privateDirectory, recordEffect, rollback, scanRecovery, TransactionError, validateReview, backupEntry,
} from './transaction.js';

/** The sole plan writer: per-entry replacement is recoverable, not a filesystem-wide atomic commit. */
export async function applyPlan(plan: Plan, options: ApplyOptions): Promise<ApplyResult> {
  const base = { changed: 0, unchanged: plan.summary.unchanged, findings: plan.findings };
  if (options.confirmed !== true) return { ...base, status: 'declined' };
  if (options.signal?.aborted) return { ...base, status: 'cancelled' };
  if (plan.findings.some(item => item.severity === 'error')) return { ...base, status: 'blocked' };
  const operations = [...plan.operations.filter(operation => operation.purpose === 'resource'), ...plan.operations.filter(operation => operation.purpose === 'state')];
  let release: (() => Promise<void>) | undefined;
  let transactionPath: string | undefined;
  let journal: TransactionJournal | undefined;
  let changed = 0;
  const effects = newEffects();
  try {
    if (plan.version !== 1) throw new TransactionError('INVALID_PLAN');
    await validateReview(operations, plan.preconditions);
    const pending = await scanRecovery(plan.context);
    if (pending.transactions.length || pending.findings.length) return { ...base, status: 'blocked', findings: [...plan.findings, ...pending.findings, finding('RECOVERY_PENDING')] };
    checkCancellation(options);
    if (!operations.some(operation => operationChanges(operation))) return { ...base, status: 'unchanged' };
    const storage = await initializeStorage(plan.context, effects);
    const id = randomUUID();
    const intent: TransactionJournal = { version: 1, id, context: plan.context, status: 'prepared', entries: [] };
    release = await acquireLock(storage.lockPath, false, intent);
    await recordEffect(effects, await snapshotPath(storage.lockPath));
    await validateReview(operations, plan.preconditions, effects);
    const lockedPending = await scanRecovery(plan.context);
    if (lockedPending.transactions.length || lockedPending.findings.length) throw new TransactionError('RECOVERY_PENDING');
    checkCancellation(options);
    await privateDirectory(storage.transactionRoot, effects);
    transactionPath = join(storage.transactionRoot, id);
    await privateDirectory(transactionPath, effects);
    await privateDirectory(join(transactionPath, 'backups'), effects);
    journal = intent;
    await persistJournal(transactionPath, journal, effects);
    for (const operation of operations) {
      checkCancellation(options);
      await validateReview([operation], plan.preconditions, effects);
      const before = await checkExpected(operation.expected, effects);
      if (!operationChanges(operation, before)) continue;
      const index: number = journal.entries.length;
      const backupPath = before.kind === 'missing' ? undefined : join(transactionPath, 'backups', String(index));
      if (backupPath) {
        await backupEntry(operation.path, before, backupPath);
        await recordEffect(effects, await snapshotPath(backupPath));
      }
      const entry: JournalEntry = { path: operation.path, before, backupPath, operation: operation.kind, state: 'prepared' };
      journal = { ...journal, entries: [...journal.entries, entry] };
      await persistJournal(transactionPath, journal, effects);
      const stage = await createStage(transactionPath, index, operation.path);
      const after = await prepareOperation(operation, before, stage);
      journal = { ...journal, entries: journal.entries.map((item, itemIndex) => itemIndex === index ? { ...item, after } : item) };
      await persistJournal(transactionPath, journal, effects);
      await recordEffect(effects, await snapshotPath(stage));
      options.onCheckpoint?.('prepared', operation.path);
      checkCancellation(options);
      await validateReview([operation], plan.preconditions, effects);
      if (operation.kind !== 'chmod' && operation.kind !== 'remove') {
        const staged = await snapshotPath(join(stage, 'payload'));
        if (staged.kind !== after.kind || staged.digest !== after.digest) throw new TransactionError('STAGE_CHANGED', operation.path);
      }
      journal = { ...journal, status: 'applying', entries: journal.entries.map((item, itemIndex) => itemIndex === index ? { ...item, state: 'intent' } : item) };
      await persistJournal(transactionPath, journal, effects);
      await mutate(operation, stage);
      changed++;
      const actual = await snapshotPath(operation.path);
      if (!snapshotsEqual(after, actual)) throw new TransactionError('TARGET_CHANGED', operation.path);
      journal = { ...journal, entries: journal.entries.map((item, itemIndex) => itemIndex === index ? { ...item, after: actual, state: 'replaced' } : item) };
      await persistJournal(transactionPath, journal, effects);
      await recordEffect(effects, actual);
      options.onCheckpoint?.('replaced', operation.path);
      checkCancellation(options);
      await rm(stage, { recursive: true, force: true });
      await recordEffect(effects, await snapshotPath(stage));
    }
    checkCancellation(options);
    await validateReview(operations, plan.preconditions, effects);
    journal = { ...journal, status: 'committed' };
    await persistJournal(transactionPath, journal);
    // This notification follows the durable commit; callback failure cannot uncommit a transaction.
    try { options.onCheckpoint?.('committed', transactionPath); } catch { /* The commit is already durable. */ }
    return { ...base, status: 'applied', changed, transactionPath, backupPath: join(transactionPath, 'backups') };
  } catch (error) {
    const issue = error instanceof TransactionError ? finding(error.code, error.path) : finding('APPLY_FAILED');
    if (journal && transactionPath) {
      try {
        const restored = await rollback(transactionPath, journal);
        if (restored.findings.length === 0) await cleanupStages(transactionPath, restored.journal);
        return { ...base, status: restored.findings.length ? 'recovery-required' : changed ? 'recovered' : options.signal?.aborted ? 'cancelled' : 'blocked', changed: restored.findings.length ? changed : 0, transactionPath, backupPath: join(transactionPath, 'backups'), findings: [...plan.findings, issue, ...restored.findings] };
      } catch { return { ...base, status: 'recovery-required', changed, transactionPath, backupPath: join(transactionPath, 'backups'), findings: [...plan.findings, issue, finding('RECOVERY_FAILED', transactionPath)] }; }
    }
    return { ...base, status: options.signal?.aborted ? 'cancelled' : 'blocked', findings: [...plan.findings, issue] };
  } finally {
    if (release) {
      try { await release(); } catch { /* A changed lock belongs to recovery, never to an unchecked unlink. */ }
    }
  }
}
