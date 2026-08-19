import { t } from '../lib/i18n'

export const PAGE_SIZE_OPTIONS = [20, 30, 50, 100] as const
export type PageSize = typeof PAGE_SIZE_OPTIONS[number]

export function PageSizeSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: PageSize
  onChange: (value: PageSize) => void
  disabled?: boolean
}) {
  return (
    <label className="page-size-select">
      <span>{t('每页条数')}</span>
      <select
        value={value}
        disabled={disabled}
        aria-label={t('每页条数')}
        onChange={(event) => onChange(Number(event.target.value) as PageSize)}
      >
        {PAGE_SIZE_OPTIONS.map((option) => (
          <option value={option} key={option}>{option}</option>
        ))}
      </select>
    </label>
  )
}
