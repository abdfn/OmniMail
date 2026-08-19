import {
  AlertCircle,
  CheckSquare2,
  Copy,
  Download,
  KeyRound,
  Link2Off,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type PageInfo,
  type PublicMailboxLink,
  type PublicMailboxLinkAction,
  type PublicMailboxLinkResult,
  type PublicMailboxLinkStatus,
} from '../lib/api'
import { t } from '../lib/i18n'
import { AdminPageHeader } from './AdminPageHeader'
import { DangerConfirmDialog } from './DangerConfirmDialog'

const emptyPage: PageInfo = { hasMore: false, nextCursor: null, limit: 50 }

export function publicLinkResultText(results: PublicMailboxLinkResult[]): string {
  return results
    .filter((item): item is PublicMailboxLinkResult & { publicUrl: string } => (
      item.status === 'issued' && Boolean(item.publicUrl)
    ))
    .map((item) => `${item.email}----${item.publicUrl}`)
    .join('\n')
}

function formatDate(value: number | null): string {
  if (!value) return t('尚未生成')
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function PublicLinkResultDialog({
  results,
  onClose,
}: {
  results: PublicMailboxLinkResult[]
  onClose: () => void
}) {
  const text = publicLinkResultText(results)
  const [copied, setCopied] = useState(false)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  async function copy() {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    setCopied(true)
  }

  function download() {
    const blob = new Blob([`\uFEFF${text}\n`], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `omnimail-public-links-${new Date().toISOString().slice(0, 10)}.txt`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mail-delete-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        ref={dialogRef}
        className="public-link-result-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-link-result-title"
        tabIndex={-1}
      >
        <header>
          <span><KeyRound size={20} /></span>
          <div>
            <p className="eyebrow">ONE-TIME LINK EXPORT</p>
            <h2 id="public-link-result-title">{t('取码链接已生成')}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t('关闭')}>
            <X size={17} />
          </button>
        </header>
        <div className="public-link-result-body">
          <p><ShieldCheck size={16} />{t('链接只显示这一次；关闭后如需再次获取，必须重置。')}</p>
          <textarea readOnly value={text} aria-label={t('邮箱和取码地址')} />
        </div>
        <footer>
          <button className="button button--secondary" type="button" onClick={() => void copy()}>
            <Copy size={16} />{t(copied ? '已复制' : '复制全部')}
          </button>
          <button className="button button--primary" type="button" onClick={download}>
            <Download size={16} />{t('下载 TXT')}
          </button>
        </footer>
      </section>
    </div>
  )
}

export function PublicMailboxLinks() {
  const [mailboxes, setMailboxes] = useState<PublicMailboxLink[]>([])
  const [page, setPage] = useState<PageInfo>(emptyPage)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<PublicMailboxLinkStatus>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<PublicMailboxLinkAction | null>(null)
  const [issuedResults, setIssuedResults] = useState<PublicMailboxLinkResult[]>([])
  const requestSequence = useRef(0)

  async function load(cursor?: string) {
    const sequence = ++requestSequence.current
    if (cursor) setLoadingMore(true)
    else setLoading(true)
    setError('')
    try {
      const result = await api.mailboxPublicLinks(query, status, cursor)
      if (sequence !== requestSequence.current) return
      setMailboxes((current) => {
        if (!cursor) return result.mailboxes
        const existing = new Set(current.map((item) => item.email))
        return [...current, ...result.mailboxes.filter((item) => !existing.has(item.email))]
      })
      setPage(result.page)
      if (!cursor) setSelected(new Set())
    } catch (loadError) {
      if (sequence === requestSequence.current) {
        setError(t(loadError instanceof Error ? loadError.message : '无法读取取码链接列表。'))
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250)
    return () => window.clearTimeout(timer)
  }, [query, status])

  const selectedItems = useMemo(
    () => mailboxes.filter((item) => selected.has(item.email)),
    [mailboxes, selected],
  )
  const allLoadedSelected = mailboxes.length > 0
    && mailboxes.slice(0, 100).every((item) => selected.has(item.email))

  function toggle(email: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(email)) next.delete(email)
      else if (next.size < 100) next.add(email)
      return next
    })
  }

  function toggleLoaded() {
    setSelected(allLoadedSelected
      ? new Set()
      : new Set(mailboxes.slice(0, 100).map((item) => item.email)))
  }

  async function performAction() {
    if (!pending || selectedItems.length === 0) return
    const action = pending
    setActionLoading(true)
    setError('')
    setNotice('')
    try {
      const response = await api.manageMailboxPublicLinks(
        action,
        selectedItems.map((item) => item.email),
      )
      const succeeded = new Set(response.results
        .filter((item) => item.status !== 'not_found')
        .map((item) => item.email))
      setMailboxes((items) => items.map((item) => succeeded.has(item.email) ? {
        ...item,
        linkEnabled: action === 'issue',
        linkCreatedAt: action === 'issue' ? Date.now() : null,
      } : item))
      const missing = response.results.filter((item) => item.status === 'not_found').length
      setNotice(t(action === 'issue'
        ? '已生成或重置 {count} 个取码链接。'
        : '已撤销 {count} 个取码链接。', { count: succeeded.size }))
      if (missing) setError(t('{count} 个邮箱已不存在，未执行操作。', { count: missing }))
      if (action === 'issue') {
        setIssuedResults(response.results.filter((item) => item.status === 'issued'))
      }
      setSelected(new Set())
      setPending(null)
    } catch (actionError) {
      setError(t(actionError instanceof Error ? actionError.message : '无法更新取码链接。'))
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <main className="admin-workspace admin-mail-workspace public-link-workspace">
      <AdminPageHeader
        icon={KeyRound}
        eyebrow="SUPER ADMIN · PUBLIC LINKS"
        title={t('取码链接')}
        description={t('为邮箱签发公开取码地址；每个链接只能读取绑定邮箱的最新验证码。')}
      />

      <section className="admin-mail-privacy" aria-label={t('链接安全说明')}>
        <ShieldCheck size={18} />
        <div>
          <strong>{t('主管理员专用')}</strong>
          <span>{t('Token 明文仅在生成时显示；重置后旧链接立即失效。')}</span>
        </div>
      </section>

      <section className="admin-mail-panel">
        <div className="admin-mail-filters public-link-filters">
          <label className="admin-mail-search">
            <Search size={16} />
            <span className="sr-only">{t('搜索邮箱或所属用户')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('搜索邮箱、用户名称或登录邮箱')}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && <button type="button" onClick={() => setQuery('')} aria-label={t('清除搜索')}><X size={14} /></button>}
          </label>
          <label>
            <span>{t('链接状态')}</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as PublicMailboxLinkStatus)}>
              <option value="all">{t('全部')}</option>
              <option value="enabled">{t('已生成')}</option>
              <option value="disabled">{t('未生成')}</option>
            </select>
          </label>
          <button className="button button--secondary button--small" type="button" onClick={() => {
            setQuery('')
            setStatus('all')
          }}><RefreshCw size={15} />{t('重置筛选')}</button>
        </div>

        <div className="admin-mail-selection">
          <span><CheckSquare2 size={16} />{selected.size
            ? t('已选择 {count} 个邮箱', { count: selected.size })
            : t('当前加载 {count} 个邮箱', { count: mailboxes.length })}</span>
          {selected.size > 0 && <div>
            <button type="button" disabled={actionLoading} onClick={() => setPending('issue')}>
              <KeyRound size={15} />{t('生成 / 重置')}
            </button>
            <button className="is-danger" type="button" disabled={actionLoading} onClick={() => setPending('revoke')}>
              <Link2Off size={15} />{t('撤销链接')}
            </button>
          </div>}
        </div>

        {error && <p className="admin-mail-feedback is-error" role="alert"><AlertCircle size={16} />{error}</p>}
        {notice && <p className="admin-mail-feedback" role="status"><ShieldCheck size={16} />{notice}</p>}

        <div className="admin-mail-table-wrap">
          <table className="admin-mail-table public-link-table">
            <thead><tr>
              <th><input type="checkbox" checked={allLoadedSelected} onChange={toggleLoaded} aria-label={t('选择当前已加载邮箱')} /></th>
              <th>{t('邮箱')}</th><th>{t('所属用户')}</th><th>{t('邮箱状态')}</th><th>{t('链接状态')}</th><th>{t('生成时间')}</th>
            </tr></thead>
            <tbody>
              {!loading && mailboxes.map((mailbox) => (
                <tr key={mailbox.email}>
                  <td><input type="checkbox" checked={selected.has(mailbox.email)} onChange={() => toggle(mailbox.email)} aria-label={t('选择邮箱：{email}', { email: mailbox.email })} /></td>
                  <td><strong>{mailbox.email}</strong></td>
                  <td><strong>{mailbox.owner.displayName}</strong><small>{mailbox.owner.email}</small></td>
                  <td><span className={`public-link-status${mailbox.isActive ? ' is-enabled' : ''}`}>{t(mailbox.isActive ? '已启用' : '已停用')}</span></td>
                  <td><span className={`public-link-status${mailbox.linkEnabled ? ' is-enabled' : ''}`}>{t(mailbox.linkEnabled ? '已生成' : '未生成')}</span></td>
                  <td><time dateTime={mailbox.linkCreatedAt ? new Date(mailbox.linkCreatedAt).toISOString() : undefined}>{formatDate(mailbox.linkCreatedAt)}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="admin-mail-state" role="status"><LoaderCircle className="spin" size={19} />{t('正在读取邮箱…')}</div>}
          {!loading && mailboxes.length === 0 && <div className="admin-mail-state"><KeyRound size={20} />{t('当前筛选范围内没有邮箱。')}</div>}
        </div>
        {page.hasMore && <button className="button button--secondary admin-mail-load-more" type="button" disabled={loadingMore} onClick={() => page.nextCursor && void load(page.nextCursor)}>{loadingMore && <LoaderCircle className="spin" size={15} />}{t(loadingMore ? '正在加载…' : '加载更多邮箱')}</button>}
      </section>

      {pending && <DangerConfirmDialog
        icon={pending === 'issue' ? KeyRound : Link2Off}
        eyebrow={t('公开取码链接')}
        title={t(pending === 'issue' ? '生成或重置所选链接？' : '撤销所选链接？')}
        description={t(pending === 'issue'
          ? '已存在的链接会立即失效，新链接仅显示一次。'
          : '撤销后，使用现有取码地址的客户端将不能继续查询。')}
        impactTitle={t(pending === 'issue' ? '旧地址不能恢复' : '公开访问将停止')}
        impactDescription={t(pending === 'issue'
          ? '请在关闭结果窗口前复制或下载全部新地址。'
          : '需要恢复时必须重新生成新的取码地址。')}
        confirmLabel={t(pending === 'issue' ? '生成 / 重置' : '撤销链接')}
        onCancel={() => setPending(null)}
        onConfirm={() => void performAction()}
      />}

      {issuedResults.length > 0 && <PublicLinkResultDialog
        results={issuedResults}
        onClose={() => setIssuedResults([])}
      />}
    </main>
  )
}
