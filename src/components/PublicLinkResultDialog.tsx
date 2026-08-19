import { Copy, Download, KeyRound, ShieldCheck, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PublicMailboxLinkResult } from '../lib/api'
import { t } from '../lib/i18n'

export function publicLinkResultText(results: PublicMailboxLinkResult[]): string {
  return results
    .filter((item): item is PublicMailboxLinkResult & { publicUrl: string } => (
      item.status === 'issued' && Boolean(item.publicUrl)
    ))
    .map((item) => `${item.email}----${item.publicUrl}`)
    .join('\n')
}

export function PublicLinkResultDialog({
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
