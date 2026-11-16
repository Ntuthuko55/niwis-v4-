import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, LoaderCircle, X } from 'lucide-react'
import { dashboardFetch } from '../services/dashboardFetch'
import {
  buildExportCsv, exportDate, exportDateBound, exportPeriod, filterExportRows, hasExportValues,
  normalizeExportMetrics, saveExportCsv,
} from '../lib/dashboardExport'
import '../niwis/dashboard-data-export.css'

const EMPTY = []

/** One export flow for source observations; source readers reuse each module's API. */
export default function DashboardDataExport({
  rows = EMPTY, metrics = EMPTY, dateField = 'date', context = {}, filename = 'NIWIS-data',
  label = 'Download data', triggerClassName = '', rowMetricField = '', valueField = 'value',
  unitField = 'unit', metricLabelField = 'indicator', extraFields = EMPTY,
  source, disabled = false, unavailableReason = '',
}) {
  const titleId = useId()
  const trigger = useRef(null)
  const dialog = useRef(null)
  const request = useRef(null)
  const [open, setOpen] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [selectedKeys, setSelectedKeys] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const availableRows = useMemo(() => Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : EMPTY, [rows])
  const dates = useMemo(() => availableRows.map(row => exportDate(row[dateField])).filter(Boolean).sort(), [availableRows, dateField])
  const granularity = source?.period || (/year/i.test(dateField) ? 'year' : /month|period/i.test(dateField) ? 'month' : 'day')
  const minDate = exportDateBound(source?.minDate || dates[0], granularity)
  const maxDate = exportDateBound(source?.maxDate || dates.at(-1), granularity, true)
  const metricOptions = useMemo(() => normalizeExportMetrics(metrics).filter(item => source || availableRows.some(row =>
    rowMetricField ? String(row[rowMetricField]) === item.key : Object.hasOwn(row, item.key))), [metrics, source, availableRows, rowMetricField])
  const allKeys = metricOptions.map(item => item.key)
  const activeKeys = selectedKeys == null ? allKeys : allKeys.filter(key => selectedKeys.includes(key))
  // A source or district change cancels an in-flight export and resets its form.
  const selectionId = JSON.stringify([filename, source?.url, source?.params, context, dateField, granularity, rowMetricField, allKeys])
  const rangeError = !startDate || !endDate ? 'Choose both dates.'
    : !exportDate(startDate) || !exportDate(endDate) ? 'Choose valid dates.'
      : startDate > endDate ? 'The end date must be on or after the start date.'
        : (minDate && startDate < minDate) || (maxDate && endDate > maxDate) ? 'Choose dates within the available source range.' : ''
  const previewRows = filterExportRows(availableRows, { dateField, granularity, start: startDate, end: endDate, rowMetricField, selectedKeys: activeKeys })
  const canOpen = !disabled && !unavailableReason && metricOptions.length > 0 && Boolean(minDate && maxDate)

  useEffect(() => {
    request.current?.abort()
    setOpen(false)
    setLoading(false)
    setError('')
    setSelectedKeys(null)
    setStartDate(minDate)
    setEndDate(maxDate)
  }, [selectionId, minDate, maxDate])

  useEffect(() => () => request.current?.abort(), [])

  useEffect(() => {
    if (!open) return undefined
    dialog.current?.querySelector('input, button')?.focus()
    const onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]') || [])]
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown); trigger.current?.focus() }
  }, [open])

  function close() {
    request.current?.abort()
    setLoading(false)
    setOpen(false)
  }

  function toggleMetric(key) {
    const next = activeKeys.includes(key) ? activeKeys.filter(item => item !== key) : [...activeKeys, key]
    setSelectedKeys(next.length === allKeys.length ? null : next)
  }

  async function download(event) {
    event.preventDefault()
    if (loading || rangeError || !activeKeys.length) return
    const controller = new AbortController()
    request.current?.abort()
    request.current = controller
    setLoading(true)
    setError('')
    try {
      let sourceRows = availableRows
      if (source) {
        const params = new URLSearchParams(Object.entries(source.params || {}).filter(([, value]) => value != null))
        if (source.queryPeriod !== false) {
          params.set('start', exportPeriod(startDate, source.queryPeriod || granularity))
          params.set('end', exportPeriod(endDate, source.queryPeriod || granularity))
        }
        const response = await dashboardFetch(`${source.url}?${params}`, { signal: controller.signal })
        const body = await response.json().catch(() => null)
        if (!response.ok || !body) throw new Error(typeof body?.detail === 'string' ? body.detail : `Data could not be retrieved (HTTP ${response.status}). Please retry.`)
        sourceRows = source.selectRows ? source.selectRows(body) : body.series
        if (!Array.isArray(sourceRows)) throw new Error('The data response did not contain observations. Please retry.')
      }
      const selectedRows = filterExportRows(sourceRows, { dateField, granularity, start: startDate, end: endDate, rowMetricField, selectedKeys: activeKeys })
      const selectedMetrics = metricOptions.filter(item => activeKeys.includes(item.key))
      if (!selectedRows.length || !hasExportValues(selectedRows, selectedMetrics, rowMetricField, valueField)) throw new Error('No observations are available for these dates and variables. Choose another range.')
      if (controller.signal.aborted) return
      const csv = buildExportCsv({ rows: selectedRows, metrics: selectedMetrics, dateField, context, extraFields, rowMetricField, valueField, unitField, metricLabelField })
      saveExportCsv(csv, `${filename}-${startDate}-${endDate}`)
      setOpen(false)
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || 'The download could not be prepared. Please retry.')
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false) }
    }
  }

  const portalTarget = trigger.current?.closest('.nw') || document.body
  return <div className="nw-data-export">
    <button ref={trigger} type="button" className={`nw-data-export-trigger ${triggerClassName}`.trim()} onClick={() => { setError(''); setOpen(true) }} aria-haspopup="dialog" aria-expanded={open} disabled={!canOpen} title={unavailableReason || (!canOpen ? 'Download becomes available when source observations have loaded.' : undefined)}>
      <Download size={15} aria-hidden="true" />{label}
    </button>
    {unavailableReason && <span className="nw-data-export-unavailable" role="status">{unavailableReason}</span>}
    {open && createPortal(<div className="nw-data-export-overlay" onClick={event => { if (event.target === event.currentTarget) close() }}>
      <form ref={dialog} className="nw-data-export-menu" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={loading} onSubmit={download}>
        <header className="nw-data-export-head"><div><h2 id={titleId}>Download data</h2><p>Choose the dates and variables for your CSV.</p></div><button type="button" aria-label="Close download options" onClick={close}><X size={18} /></button></header>
        <p className="nw-data-export-coverage">Available: {minDate} to {maxDate}{granularity === 'year' ? ' · Annual observations' : granularity === 'month' ? ' · Monthly observations' : ''}</p>
        <div className="nw-data-export-dates">
          <label>From<input type="date" required min={minDate} max={maxDate} value={startDate} disabled={loading} onChange={event => setStartDate(event.target.value)} /></label>
          <label>To<input type="date" required min={minDate} max={maxDate} value={endDate} disabled={loading} onChange={event => setEndDate(event.target.value)} /></label>
        </div>
        {granularity !== 'day' && <p className="nw-data-export-note">The CSV includes each {granularity === 'year' ? 'year' : 'month'} touched by the selected dates.</p>}
        <div className="nw-data-export-variable-head"><strong>Variables ({activeKeys.length} selected)</strong><div><button type="button" disabled={loading} onClick={() => setSelectedKeys(null)}>Select all</button><button type="button" disabled={loading} onClick={() => setSelectedKeys([])}>Clear</button></div></div>
        <div className="nw-data-export-variables">{metricOptions.map(item => <label key={item.key}><input type="checkbox" disabled={loading} checked={activeKeys.includes(item.key)} onChange={() => toggleMetric(item.key)} /><span>{item.label}{item.unit ? ` (${item.unit})` : ''}</span></label>)}</div>
        <p className="nw-data-export-note">{source ? 'Observations will be retrieved for the selected dates and current region.' : `${previewRows.length.toLocaleString()} records in range.`} Missing measurements remain blank.</p>
        {(error || rangeError) && <p className="nw-data-export-error" role="alert">{error || rangeError}</p>}
        <button type="submit" className="nw-data-export-download" disabled={loading || Boolean(rangeError) || !activeKeys.length}>{loading ? <><LoaderCircle size={16} className="nw-data-export-spinner" aria-hidden="true" />Preparing CSV…</> : <><Download size={16} aria-hidden="true" />Download CSV</>}</button>
      </form>
    </div>, portalTarget)}
  </div>
}
