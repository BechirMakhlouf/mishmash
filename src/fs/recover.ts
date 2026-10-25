import { join, resolve } from 'node:path';
import type { ApplyOptions, Context, RecoveryResult, RecoveryStatus, TransactionJournal } from '../model.js';
import { getStatePaths } from '../state.js';
import { errorCode, fingerprintValue } from './snapshot.js';
import {
  acquireLock, checkCancellation, cleanupStages, finding, initializeStorage, newEffects,
  persistJournal, privateDirectory, readJournal, rollback, scanRecovery, TransactionError, validateJournal,
} from './transaction.js';

/** Inspection never creates a lock, transaction directory, or recovery metadata. */
export async function inspectRecovery(context: Context): Promise<RecoveryStatus> {
  try { return await scanRecovery(context); }
  catch { return { transactions: [], findings: [finding('RECOVERY_UNREADABLE')] }; }
}

/** Recovery is a separate, explicit decision; an external edit is never overwritten to make it succeed. */
export async function recoverTransaction(transaction: { path: string; journal: TransactionJournal }, options: ApplyOptions): Promise<RecoveryResult> {
  const base = { changed: 0, unchanged: 0, findings: [] };
  if (options.confirmed !== true) return { ...base, status: 'declined' };
  if (options.signal?.aborted) return { ...base, status: 'cancelled' };
  let release: (() => Promise<void>) | undefined;
  try {
    const storage = await getStatePaths(transaction.journal.context);
    validateJournal(transaction.path, transaction.journal, storage.transactionRoot);
    const inspected = await scanRecovery(transaction.journal.context);
    if (inspected.findings.length) return { ...base, status: 'blocked', findings: inspected.findings };
    let journal: TransactionJournal;
    let materialize = false;
    try { journal = await readJournal(transaction.path, storage.transactionRoot); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT' && !(error instanceof TransactionError && error.code === 'MISSING_RECOVERY_JOURNAL')) throw error;
      const orphan = inspected.transactions.find(candidate => resolve(candidate.path) === resolve(transaction.path));
      if (!orphan || orphan.journal.entries.length !== 0) throw new TransactionError('RECOVERY_CHANGED', transaction.path);
      journal = orphan.journal;
      materialize = true;
    }
    if (fingerprintValue(journal) !== fingerprintValue(transaction.journal)) throw new TransactionError('RECOVERY_CHANGED', transaction.path);
    checkCancellation(options);
    await initializeStorage(journal.context, newEffects());
    const intent: TransactionJournal = { version: 1, id: journal.id, context: journal.context, status: 'prepared', entries: [] };
    release = await acquireLock(storage.lockPath, true, intent);
    checkCancellation(options);
    try {
      const locked = await readJournal(transaction.path, storage.transactionRoot);
      if (fingerprintValue(locked) !== fingerprintValue(journal)) throw new TransactionError('RECOVERY_CHANGED', transaction.path);
    } catch (error) {
      if (!materialize || (errorCode(error) !== 'ENOENT' && !(error instanceof TransactionError && error.code === 'MISSING_RECOVERY_JOURNAL'))) throw error;
    }
    await privateDirectory(storage.transactionRoot);
    await privateDirectory(transaction.path);
    // Materialize an orphan lock's empty journal only after explicit approval and lock ownership.
    if (materialize) await persistJournal(transaction.path, journal);
    if (journal.status === 'committed' || journal.status === 'recovered') {
      await cleanupStages(transaction.path, journal);
      return { ...base, status: 'recovered', transactionPath: transaction.path, backupPath: join(transaction.path, 'backups') };
    }
    const restored = await rollback(transaction.path, journal);
    if (restored.findings.length === 0) await cleanupStages(transaction.path, restored.journal);
    return { ...base, status: restored.findings.length ? 'recovery-required' : 'recovered', transactionPath: transaction.path, backupPath: join(transaction.path, 'backups'), findings: restored.findings };
  } catch (error) {
    return { ...base, status: options.signal?.aborted ? 'cancelled' : 'recovery-required', transactionPath: transaction.path, findings: [finding(error instanceof TransactionError ? error.code : 'RECOVERY_FAILED', transaction.path)] };
  } finally {
    if (release) { try { await release(); } catch { /* Never remove a changed or foreign lock. */ } }
  }
}
