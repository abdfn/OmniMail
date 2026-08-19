import {
  AlertCircle,
  Ban,
  CheckSquare2,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  CircleOff,
  KeyRound,
  LoaderCircle,
  MailPlus,
  Mails,
  Power,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  api,
  type AdminMailbox,
  type AdminMailboxBulkAction,
  type AdminMailboxBulkResult,
  type AdminMailboxStatusFilter,
  type AdminMailboxTotals,
  type ManagedDomain,
  type PageInfo,
  type PublicMailboxLinkResult,
  type User,
} from '../lib/api'
import { t } from '../lib/i18n'
import { roleLabel } from '../lib/roles'
import { AdminPageHeader } from './AdminPageHeader'
import { DangerConfirmDialog } from './DangerConfirmDialog'
import { PageSizeSelect, type PageSize } from './PageSizeSelect'
import { PublicLinkResultDialog } from './PublicLinkResultDialog'

const emptyPage: PageInfo = { hasMore: false, nextCursor: null, limit: 50 }
const emptyTotals: AdminMailboxTotals = { total: 0, active: 0, disabled: 0, publicLinks: 0 }

type PendingAction = AdminMailboxBulkAction | 'publicLinks'

export function adminMailboxResultSummary(results: AdminMailboxBulkResult[]): {
  completed: number
  skipped: number
} {
  const completedStatuses = new Set(['updated', 'unchanged', 'scheduled'])
  const completed = results.filter((item) => completedStatuses.has(item.status)).length
  return { completed, skipped: results.length - completed }
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function CreateMailboxDialog({
  defaultOwnerEmail,
  domains,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  defaultOwnerEmail: string
  domains: ManagedDomain[]
  busy: boolean
  error: string
  onClose: () => void
  onSubmit: (input: { ownerEmail: string; domain: string; count: number }) => void
}) {
  const enabledDomains = domains.filter((domain) => domain.isActive)
  const [ownerEmail, setOwnerEmail] = useState(defaultOwnerEmail)
  const [domain, setDomain] = useState(enabledDomains[0]?.name || '')
  const [count, setCount] = useState('10')
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) closeRef.current()
    }
    window.addEventListener('keydown', keyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', keyDown)
    }
  }, [busy])

  function submit(event: FormEvent) {
    event.preventDefault()
    const amount = Number(count)
    if (!ownerEmail.trim() || !domain || !Number.isInteger(amount) || amount < 1 || amount > 100) return
    onSubmit({ ownerEmail: ownerEmail.trim(), domain, count: amount })
  }

  return (
    <div className="mail-delete-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <section
        ref={dialogRef}
        className="admin-mailbox-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-mailbox-create-title"
      >
        <header>
          <span><MailPlus size={20} /></span>
          <div>
            <p className="eyebrow">SUPER ADMIN · BULK CREATE</p>
            <h2 id="admin-mailbox-create-title">{t('批量生成邮箱')}</h2>
          </div>
          <button className="icon-button" type="button" disabled={busy} onClick={onClose} aria-label={t('关闭')}>
            <X size={17} />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="admin-mailbox-create-fields">
            <label>
              <span>{t('所属用户登录邮箱')}</span>
              <input
                type="email"
                value={ownerEmail}
                maxLength={254}
                required
                disabled={busy}
                placeholder="owner@example.com"
                onChange={(event) => setOwnerEmail(event.target.value)}
              />
            </label>
            <label>
              <span>{t('邮箱域名')}</span>
              <select value={domain} required disabled={busy} onChange={(event) => setDomain(event.target.value)}>
                {enabledDomains.map((item) => <option key={item.name} value={item.name}>@{item.name}</option>)}
              </select>
            </label>
            <label>
              <span>{t('生成数量')}</span>
              <input
                type="number"
                min="1"
                max="100"
                step="1"
                value={count}
                required
                disabled={busy}
                onChange={(event) => setCount(event.target.value)}
              />
            </label>
          </div>
          <p className="admin-mailbox-create-note">
            <ShieldCheck size={16} />
            {t('系统使用自然词组随机生成前缀，并自动避开已占用或已预留地址。')}
          </p>
          {error && <p className="admin-mailbox-create-error" role="alert"><AlertCircle size={16} />{error}</p>}
          <footer>
            <button className="button button--secondary" type="button" disabled={busy} onClick={onClose}>{t('取消')}</button>
            <button className="button button--primary" type="submit" disabled={busy || !enabledDomains.length}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <MailPlus size={16} />}
              {t(busy ? '正在生成…' : '生成邮箱')}
            </button>
          </footer>
        </form>
      </section>
    </div>
  )
}

export function AdminMailboxManagement({
  currentUser,
  domains,
}: {
  currentUser: User
  domains: ManagedDomain[]
}) {
  const [mailboxes, setMailboxes] = useState<AdminMailbox[]>([])
  const [totals, setTotals] = useState<AdminMailboxTotals>(emptyTotals)
  const [page, setPage] = useState<PageInfo>(emptyPage)
  const [pageSize, setPageSize] = useState<PageSize>(50)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<AdminMailboxStatusFilter>('all')
  const [cursor, setCursor] = useState<string>()
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [issuedResults, setIssuedResults] = useState<PublicMailboxLinkResult[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const requestSequence = useRef(0)

  async function load() {
    const sequence = ++requestSequence.current
    setLoading(true)
    setError('')
    try {
      const result = await api.adminMailboxes({ query, status, limit: pageSize, cursor })
      if (sequence !== requestSequence.current) return
      setMailboxes(result.mailboxes)
      setPage(result.page)
      setTotals(result.totals)
      setSelected(new Set())
    } catch (loadError) {
      if (sequence === requestSequence.current) {
        setError(t(loadError instanceof Error ? loadError.message : '无法读取邮箱管理列表。'))
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [query, status, pageSize, cursor, reloadKey])

  const selectedItems = useMemo(
    () => mailboxes.filter((mailbox) => selected.has(mailbox.address)),
    [mailboxes, selected],
  )
  const allSelected = mailboxes.length > 0 && mailboxes.every((mailbox) => selected.has(mailbox.address))

  function resetPagination() {
    setCursor(undefined)
    setCursorHistory([])
  }

  function toggle(address: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(address)) next.delete(address)
      else if (next.size < 100) next.add(address)
      return next
    })
  }

  function togglePage() {
    setSelected(allSelected ? new Set() : new Set(mailboxes.map((mailbox) => mailbox.address)))
  }

  function requestAction(action: PendingAction) {
    setDeleteConfirmation('')
    setPending(action)
  }

  async function createMailboxes(input: { ownerEmail: string; domain: string; count: number }) {
    setActionLoading(true)
    setError('')
    setNotice('')
    try {
      const result = await api.createAdminMailboxes(input)
      setCreateOpen(false)
      setQuery('')
      setStatus('all')
      resetPagination()
      setNotice(t('已生成 {count} 个邮箱。', { count: result.createdCount }))
      setReloadKey((value) => value + 1)
    } catch (createError) {
      setError(t(createError instanceof Error ? createError.message : '无法批量生成邮箱。'))
    } finally {
      setActionLoading(false)
    }
  }

  async function performAction() {
    const action = pending
    const addresses = selectedItems.map((mailbox) => mailbox.address)
    if (!action || !addresses.length || actionLoading) return
    setPending(null)
    setActionLoading(true)
    setError('')
    setNotice('')
    try {
      if (action === 'publicLinks') {
        const response = await api.manageMailboxPublicLinks('issue', addresses)
        const issued = response.results.filter((item) => item.status === 'issued')
        setIssuedResults(issued)
        setNotice(t('已生成或重置 {count} 个取码链接。', { count: issued.length }))
      } else {
        const response = await api.manageAdminMailboxes(action, addresses)
        const summary = adminMailboxResultSummary(response.results)
        setNotice(t(action === 'enable'
          ? '已启用 {count} 个邮箱。'
          : action === 'disable'
            ? '已停用 {count} 个邮箱。'
            : '已提交 {count} 个邮箱删除任务。', { count: summary.completed }))
        if (summary.skipped) {
          setError(t('{count} 个邮箱因主邮箱保护、域名状态或任务失败而跳过。', {
            count: summary.skipped,
          }))
        }
      }
      setReloadKey((value) => value + 1)
    } catch (actionError) {
      setError(t(actionError instanceof Error ? actionError.message : '无法批量更新邮箱。'))
    } finally {
      setActionLoading(false)
    }
  }

  function nextPage() {
    if (!page.nextCursor) return
    setCursorHistory((history) => [...history, cursor])
    setCursor(page.nextCursor)
  }

  function previousPage() {
    if (!cursorHistory.length) return
    const history = [...cursorHistory]
    setCursor(history.pop())
    setCursorHistory(history)
  }

  const pendingDialog = pending && selectedItems.length > 0 ? {
    icon: pending === 'publicLinks' ? KeyRound : pending === 'enable' ? Power : pending === 'disable' ? Ban : Trash2,
    eyebrow: t(pending === 'publicLinks' ? '公开取码链接' : '邮箱批量操作'),
    title: t(pending === 'publicLinks'
      ? '生成所选邮箱的取码地址？'
      : pending === 'enable'
        ? '启用所选邮箱？'
        : pending === 'disable'
          ? '停用所选邮箱？'
          : '永久删除所选邮箱？'),
    description: t(pending === 'publicLinks'
      ? '已有取码地址会立即失效，新地址只显示一次。'
      : pending === 'enable'
        ? '邮箱恢复后可以继续接收新邮件。'
        : pending === 'disable'
          ? '停用后邮箱停止接收新邮件，主邮箱会自动跳过。'
          : '邮箱及其邮件会进入异步清理流程，主邮箱会自动跳过。'),
    impactTitle: t(pending === 'delete' ? '删除后不能恢复' : '批量操作立即生效'),
    impactDescription: t(pending === 'publicLinks'
      ? '请在结果窗口关闭前复制或下载全部地址。'
      : pending === 'delete'
        ? '关联邮件、附件和公开取码地址都会被清理。'
        : '可在邮箱管理页查看每个邮箱的最新状态。'),
    confirmLabel: t(pending === 'publicLinks'
      ? '生成取码地址'
      : pending === 'enable'
        ? '确认启用'
        : pending === 'disable'
          ? '确认停用'
          : '确认删除'),
  } : null

  return (
    <main className="admin-workspace admin-mail-workspace admin-mailbox-workspace">
      <AdminPageHeader
        icon={Mails}
        eyebrow="SUPER ADMIN · MAILBOXES"
        title={t('邮箱管理')}
        description={t('分页管理全站邮箱，支持批量生成、启停、删除和签发取码地址。')}
        className="user-management__header"
        actions={<div className="user-header-actions"><button className="button button--primary user-add-button" type="button" onClick={() => { setError(''); setCreateOpen(true) }}><MailPlus size={16} />{t('批量生成邮箱')}</button></div>}
      />

      <section className="admin-mailbox-summary" aria-label={t('邮箱统计')}>
        <div><Mails size={19} /><span><strong>{totals.total}</strong><small>{t('邮箱总数')}</small></span></div>
        <div><CircleCheckBig size={19} /><span><strong>{totals.active}</strong><small>{t('启用邮箱')}</small></span></div>
        <div><CircleOff size={19} /><span><strong>{totals.disabled}</strong><small>{t('停用邮箱')}</small></span></div>
        <div><KeyRound size={19} /><span><strong>{totals.publicLinks}</strong><small>{t('已有取码地址')}</small></span></div>
      </section>

      <section className="admin-mail-panel">
        <div className="admin-mail-filters admin-mailbox-filters">
          <label className="admin-mail-search">
            <Search size={16} />
            <span className="sr-only">{t('搜索邮箱或所属用户')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('搜索邮箱、用户名称或登录邮箱')}
              onChange={(event) => { setQuery(event.target.value); resetPagination() }}
            />
            {query && <button type="button" onClick={() => { setQuery(''); resetPagination() }} aria-label={t('清除搜索')}><X size={14} /></button>}
          </label>
          <label>
            <span>{t('邮箱状态')}</span>
            <select value={status} onChange={(event) => { setStatus(event.target.value as AdminMailboxStatusFilter); resetPagination() }}>
              <option value="all">{t('全部')}</option>
              <option value="enabled">{t('已启用')}</option>
              <option value="disabled">{t('已停用')}</option>
            </select>
          </label>
          <button className="button button--secondary button--small" type="button" onClick={() => { setQuery(''); setStatus('all'); resetPagination() }}>
            <RefreshCw size={15} />{t('重置筛选')}
          </button>
        </div>

        <div className="admin-mail-selection">
          <span><CheckSquare2 size={16} />{selected.size
            ? t('已选择 {count} 个邮箱', { count: selected.size })
            : t('当前页 {count} 个邮箱', { count: mailboxes.length })}</span>
          {selected.size > 0 && <div>
            <button type="button" disabled={actionLoading} onClick={() => requestAction('publicLinks')}><KeyRound size={15} />{t('生成取码地址')}</button>
            <button type="button" disabled={actionLoading} onClick={() => requestAction('enable')}><Power size={15} />{t('批量启用')}</button>
            <button type="button" disabled={actionLoading} onClick={() => requestAction('disable')}><Ban size={15} />{t('批量停用')}</button>
            <button className="is-danger" type="button" disabled={actionLoading} onClick={() => requestAction('delete')}><Trash2 size={15} />{t('批量删除')}</button>
          </div>}
        </div>

        {error && <p className="admin-mail-feedback is-error" role="alert"><AlertCircle size={16} />{error}</p>}
        {notice && <p className="admin-mail-feedback" role="status"><ShieldCheck size={16} />{notice}</p>}

        <div className="admin-mail-table-wrap">
          <table className="admin-mail-table admin-mailbox-table">
            <thead><tr>
              <th><input type="checkbox" checked={allSelected} onChange={togglePage} aria-label={t('选择当前页邮箱')} /></th>
              <th>{t('邮箱')}</th><th>{t('所属用户')}</th><th>{t('域名')}</th><th>{t('邮箱状态')}</th><th>{t('类型')}</th><th>{t('取码地址')}</th><th>{t('创建时间')}</th>
            </tr></thead>
            <tbody>
              {!loading && mailboxes.map((mailbox) => (
                <tr key={mailbox.address}>
                  <td><input type="checkbox" checked={selected.has(mailbox.address)} onChange={() => toggle(mailbox.address)} aria-label={t('选择邮箱：{email}', { email: mailbox.address })} /></td>
                  <td><strong>{mailbox.address}</strong><small>{mailbox.domain}</small></td>
                  <td><strong>{mailbox.owner.displayName}</strong><small>{mailbox.owner.email} · {roleLabel(mailbox.owner.role)}</small></td>
                  <td><span>@{mailbox.domain}</span></td>
                  <td><span className={`public-link-status${mailbox.isActive ? ' is-enabled' : ''}`}>{t(mailbox.isActive ? '已启用' : '已停用')}</span></td>
                  <td><span className="admin-mailbox-kind">{t(mailbox.isPrimary ? '主邮箱' : '普通邮箱')}</span></td>
                  <td><span className={`public-link-status${mailbox.linkEnabled ? ' is-enabled' : ''}`}>{t(mailbox.linkEnabled ? '已生成' : '未生成')}</span></td>
                  <td><time dateTime={new Date(mailbox.createdAt).toISOString()}>{formatDate(mailbox.createdAt)}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="admin-mail-state" role="status"><LoaderCircle className="spin" size={19} />{t('正在读取邮箱…')}</div>}
          {!loading && mailboxes.length === 0 && <div className="admin-mail-state"><Mails size={20} />{t('当前筛选范围内没有邮箱。')}</div>}
        </div>

        <footer className="admin-mailbox-pagination">
          <PageSizeSelect value={pageSize} disabled={loading} onChange={(value) => {
            setPageSize(value)
            resetPagination()
          }} />
          <div className="admin-mailbox-pagination__navigation">
            <button className="button button--secondary button--small" type="button" disabled={!cursorHistory.length || loading} onClick={previousPage}><ChevronLeft size={15} />{t('上一页')}</button>
            <span>{t('第 {page} 页', { page: cursorHistory.length + 1 })}</span>
            <button className="button button--secondary button--small" type="button" disabled={!page.hasMore || loading} onClick={nextPage}>{t('下一页')}<ChevronRight size={15} /></button>
          </div>
        </footer>
      </section>

      {createOpen && createPortal(<CreateMailboxDialog
        defaultOwnerEmail={currentUser.email}
        domains={domains}
        busy={actionLoading}
        error={error}
        onClose={() => { setCreateOpen(false); setError('') }}
        onSubmit={(input) => void createMailboxes(input)}
      />, document.body)}

      {pendingDialog && createPortal(<DangerConfirmDialog
        {...pendingDialog}
        confirmation={pending === 'delete' ? {
          label: t('请输入 {count} 以确认批量删除', { count: selectedItems.length }),
          expected: String(selectedItems.length),
          value: deleteConfirmation,
          onChange: setDeleteConfirmation,
        } : undefined}
        onCancel={() => setPending(null)}
        onConfirm={() => void performAction()}
      />, document.body)}

      {issuedResults.length > 0 && createPortal(
        <PublicLinkResultDialog results={issuedResults} onClose={() => setIssuedResults([])} />,
        document.body,
      )}
    </main>
  )
}
