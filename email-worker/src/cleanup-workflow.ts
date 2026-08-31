import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'
import {
  CLEANUP_BATCH_SIZE,
  completeRetentionCleanup,
  purgeDeletedAccountBatch,
  purgeMailboxMessagesBatch,
  purgeMessagesBatch,
  releaseRetentionClaim,
} from './cleanup'
import { purgeMailboxDrafts } from './draft-api'
import { BACKUP_RETENTION_RULES, purgeBackupObjectsPage } from './backup-retention'
import { ensureSchema } from './schema'
import { retentionValues } from './storage-policy'
import type { CleanupWorkflowParams, Env } from './types'

const MAX_BATCHES_PER_PHASE = 100
const MAX_BACKUP_PAGES_PER_RULE = 100

export class OmniMailCleanupWorkflow extends WorkflowEntrypoint<Env, CleanupWorkflowParams> {
  async run(
    event: Readonly<WorkflowEvent<CleanupWorkflowParams>>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const now = event.payload?.startedAt || Math.floor(Date.now() / 1000)
    if (event.payload?.domainDeletion) {
      return this.purgeDomain(step, now, event.payload.domainDeletion)
    }
    if (event.payload?.mailboxDeletion) {
      return this.purgeMailbox(step, now, event.payload.mailboxDeletion)
    }
    try {
      await step.do('Ensure schema', () => ensureSchema(this.env.DB))
      const policy = await step.do('Read retention policy', () => retentionValues(this.env.DB))
      let pending = await this.purgeMessagePhase(step, 'expired', now)
      pending = await this.purgeMessagePhase(
        step,
        'failed',
        now - policy.failedMessageRetentionDays * 24 * 60 * 60,
      ) || pending
      pending = await this.purgeAccountPhase(
        step,
        now - policy.temporaryDataRetentionDays * 24 * 60 * 60,
      ) || pending
      pending = await this.purgeBackupPhase(step, now) || pending
      await step.do('Purge expired metadata', async () => {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `DELETE FROM audit_logs WHERE id IN (
              SELECT id FROM audit_logs WHERE created_at < ? ORDER BY id LIMIT 500
            )`,
          ).bind(now - policy.auditRetentionDays * 24 * 60 * 60),
          this.env.DB.prepare(
            `DELETE FROM resend_webhook_events WHERE event_id IN (
              SELECT event_id FROM resend_webhook_events WHERE created_at < ? LIMIT 500
            )`,
          ).bind(now - 90 * 24 * 60 * 60),
          this.env.DB.prepare(
            `DELETE FROM backup_runs WHERE id IN (
              SELECT id FROM backup_runs WHERE started_at < ? LIMIT 100
            )`,
          ).bind(now - 400 * 24 * 60 * 60),
        ])
      })
      if (pending) {
        await step.do('Schedule cleanup continuation', () => releaseRetentionClaim(this.env.DB, now))
      } else {
        await step.do('Record cleanup success', () => completeRetentionCleanup(this.env.DB, now))
      }
      return { pending, batchSize: CLEANUP_BATCH_SIZE }
    } catch (error) {
      await step.do('Release failed cleanup claim', () => releaseRetentionClaim(this.env.DB, now))
      throw error
    }
  }

  private async purgeMailbox(
    step: WorkflowStep,
    startedAt: number,
    mailbox: NonNullable<CleanupWorkflowParams['mailboxDeletion']>,
  ): Promise<unknown> {
    const completed = await this.purgeMailboxData(step, mailbox, false)
    if (completed) return { pending: false, mailbox: mailbox.address }

    await step.do('Schedule mailbox cleanup continuation', async () => {
      if (!this.env.CLEANUP_WORKFLOW) throw new Error('CLEANUP_WORKFLOW is not configured')
      await this.env.CLEANUP_WORKFLOW.create({
        id: `mailbox-delete-${crypto.randomUUID()}`,
        params: { startedAt, mailboxDeletion: mailbox },
        retention: { successRetention: '3 days', errorRetention: '7 days' },
      })
    })
    return { pending: true, mailbox: mailbox.address }
  }

  private async purgeMailboxData(
    step: WorkflowStep,
    mailbox: NonNullable<CleanupWorkflowParams['mailboxDeletion']>,
    allowPrimary: boolean,
  ): Promise<boolean> {
    for (let index = 0; index < MAX_BATCHES_PER_PHASE; index += 1) {
      const count = await step.do(
        `Purge mailbox messages ${index + 1}`,
        () => purgeMailboxMessagesBatch(this.env, mailbox.userId, mailbox.address),
      )
      if (count < CLEANUP_BATCH_SIZE) {
        await step.do(
          'Purge mailbox drafts',
          () => purgeMailboxDrafts(this.env, mailbox.userId, mailbox.address),
        )
        await step.do('Delete mailbox record', async () => {
          await this.env.DB.batch([
            this.env.DB.prepare(
              `DELETE FROM mailboxes
                WHERE address = ? AND user_id = ? AND is_hidden = 1
                  ${allowPrimary ? '' : 'AND is_primary = 0'}`,
            ).bind(mailbox.address, mailbox.userId),
            this.env.DB.prepare(
              `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
               VALUES ((SELECT id FROM users WHERE id = ?),
                       'mailbox.delete', ?, 'workflow', '{"scheduledCleanup":true}')`,
            ).bind(mailbox.requestedBy, mailbox.address),
          ])
        })
        return true
      }
    }
    return false
  }

  private async purgeDomain(
    step: WorkflowStep,
    startedAt: number,
    deletion: NonNullable<CleanupWorkflowParams['domainDeletion']>,
  ): Promise<unknown> {
    const mailbox = await step.do('Find next domain mailbox', () => this.env.DB.prepare(
      `SELECT address, user_id
         FROM mailboxes
        WHERE is_hidden = 1
          AND LOWER(SUBSTR(address, INSTR(address, '@') + 1)) = ?
        ORDER BY address
        LIMIT 1`,
    ).bind(deletion.domain).first<{ address: string; user_id: string }>())

    if (!mailbox) {
      await step.do('Finalize domain deletion', async () => {
        await this.env.DB.batch([
          this.env.DB.prepare('DELETE FROM temporary_invites WHERE domain_name = ?')
            .bind(deletion.domain),
          this.env.DB.prepare('DELETE FROM settings WHERE key = ?')
            .bind(`domain_deleting:${deletion.domain}`),
          this.env.DB.prepare('DELETE FROM domains WHERE name = ?')
            .bind(deletion.domain),
          this.env.DB.prepare(
            `INSERT INTO audit_logs (user_id, action, target_id, ip, detail_json)
             VALUES ((SELECT id FROM users WHERE id = ?),
                     'domain.delete_complete', ?, 'workflow', '{}')`,
          ).bind(deletion.requestedBy, deletion.domain),
        ])
      })
      return { pending: false, domain: deletion.domain }
    }

    const mailboxDeletion = {
      address: mailbox.address,
      userId: mailbox.user_id,
      requestedBy: deletion.requestedBy,
    }
    await this.purgeMailboxData(step, mailboxDeletion, true)
    await step.do('Schedule domain cleanup continuation', async () => {
      if (!this.env.CLEANUP_WORKFLOW) throw new Error('CLEANUP_WORKFLOW is not configured')
      await this.env.CLEANUP_WORKFLOW.create({
        id: `domain-delete-${crypto.randomUUID()}`,
        params: { startedAt, domainDeletion: deletion },
        retention: { successRetention: '3 days', errorRetention: '7 days' },
      })
    })
    return { pending: true, domain: deletion.domain, mailbox: mailbox.address }
  }

  private async purgeMessagePhase(
    step: WorkflowStep,
    kind: 'expired' | 'failed',
    cutoff: number,
  ): Promise<boolean> {
    for (let index = 0; index < MAX_BATCHES_PER_PHASE; index += 1) {
      const count = await step.do(
        `Purge ${kind} messages ${index + 1}`,
        () => purgeMessagesBatch(this.env, kind, cutoff),
      )
      if (count < CLEANUP_BATCH_SIZE) return false
    }
    return true
  }

  private async purgeAccountPhase(step: WorkflowStep, cutoff: number): Promise<boolean> {
    for (let index = 0; index < MAX_BATCHES_PER_PHASE; index += 1) {
      const processed = await step.do(
        `Purge deleted account data ${index + 1}`,
        () => purgeDeletedAccountBatch(this.env, cutoff),
      )
      if (!processed) return false
    }
    return true
  }

  private async purgeBackupPhase(step: WorkflowStep, now: number): Promise<boolean> {
    if (!this.env.BACKUP_BUCKET) return false
    let pending = false
    for (const rule of BACKUP_RETENTION_RULES) {
      let cursor: string | undefined
      for (let index = 0; index < MAX_BACKUP_PAGES_PER_RULE; index += 1) {
        const result = await step.do(
          `Purge backup ${rule.prefix} ${index + 1}`,
          () => purgeBackupObjectsPage(
            this.env.BACKUP_BUCKET!,
            rule.prefix,
            (now - rule.days * 24 * 60 * 60) * 1000,
            cursor,
          ),
        )
        cursor = result.nextCursor || undefined
        if (!cursor) break
      }
      pending = pending || Boolean(cursor)
    }
    return pending
  }
}
