import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowDownToLine, Bot, CheckCircle2, FileChartColumnIncreasing, FileText, LoaderCircle, Sparkles, X } from 'lucide-react'
import '../niwis/dashboard-report.css'

const REPORT_DASHBOARDS = {
  monitoring: ['drought-monitoring', 'Drought Monitoring'],
  climate: ['climate', 'Climate Dashboard'], 'climate-temperature': ['climate', 'Climate Dashboard'],
  'climate-spells': ['climate', 'Climate Dashboard'], 'climate-rainfall': ['climate', 'Climate Dashboard'],
  'climate-evaporation': ['climate', 'Climate Dashboard'], 'climate-irrigation': ['climate', 'Climate Dashboard'],
  'climate-streamflow': ['climate', 'Climate Dashboard'], vegetation: ['vegetation', 'Vegetation Condition'],
  rainfall: ['rainfall', 'Rainfall Status'], runoff: ['runoff', 'Runoff Status'],
  surface: ['surface-water', 'Surface Water Network'], groundwater: ['groundwater', 'Groundwater Level Monitoring'],
  'groundwater-reserve': ['groundwater-reserve', 'Groundwater Reserve Assessment'],
  'water-quality': ['water-quality', 'Water Quality Monitoring'], dams: ['reservoirs', 'Dam and Reservoir Status'],
  wastewater: ['wastewater', 'Wastewater Quality Compliance'], 'drinking-water': ['drinking-water', 'Drinking Water Quality Compliance'],
  rwqo: ['rwqo', 'Resource Water Quality Objectives'], wrm: ['wrm', 'Water Resource Management'],
  'water-quantity': ['water-quantity', 'Water Quantity Assessment'], 'water-services': ['water-services', 'Water Services'],
  'water-tariffs': ['municipal-tariffs', 'Water Tariffs and Quality Costs'],
}
const CLIMATE_SECTION = {
  'climate-temperature': 'temperature', 'climate-spells': 'spells', 'climate-rainfall': 'rainfall',
  'climate-evaporation': 'evaporation', 'climate-irrigation': 'irrigation', 'climate-streamflow': 'streamflow',
}

async function parseResponse(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.detail || ('The report service returned HTTP ' + response.status + '.'))
  return body
}

export default function DashboardReport({ view }) {
  const selected = REPORT_DASHBOARDS[view]
  const [open, setOpen] = useState(false)
  const [region, setRegion] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [season, setSeason] = useState('Annual')
  const [section, setSection] = useState('access')
  const [dataset, setDataset] = useState('raw')
  const [status, setStatus] = useState('idle')
  const [error, setError] = useState('')
  const [report, setReport] = useState(null)
  const [download, setDownload] = useState(false)
  const [downloadError, setDownloadError] = useState('')

  const dashboard = selected?.[0]
  const title = selected?.[1]
  const generatedDate = useMemo(() => report?.generated_at ? new Date(report.generated_at).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }) : '', [report?.generated_at])

  useEffect(() => {
    setOpen(false); setStatus('idle'); setError(''); setReport(null); setDownloadError('')
    setRegion(''); setStart(''); setEnd(''); setSeason('Annual')
  }, [view])

  const filters = () => {
    const value = {}
    if (region.trim()) value.region = region.trim()
    if (start) value.start = Number(start)
    if (end) value.end = Number(end)
    if (dashboard === 'climate') {
      value.season = season
      if (CLIMATE_SECTION[view]) value.section = CLIMATE_SECTION[view]
    }
    if (dashboard === 'water-services') value.section = section
    if (dashboard === 'municipal-tariffs') {
      value.dataset = dataset
      delete value.region
    }
    return value
  }

  const generate = async event => {
    event.preventDefault()
    setStatus('loading'); setError(''); setDownloadError(''); setReport(null)
    try {
      const response = await fetch('/api/reports/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ dashboard, filters: filters() }), cache: 'no-store',
      })
      const value = await parseResponse(response)
      setReport(value); setStatus('ready')
    } catch (requestError) {
      setStatus('error')
      setError(requestError.message || 'The report could not be generated. Please try again.')
    }
  }

  const downloadPdf = async () => {
    if (!report?.pdf_url || download) return
    setDownload(true); setDownloadError('')
    try {
      const response = await fetch('/api' + report.pdf_url, { cache: 'no-store' })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.detail || 'The PDF download could not be completed.')
      }
      const blob = await response.blob()
      const filename = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-report.pdf'
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (requestError) {
      setDownloadError(requestError.message || 'The PDF download could not be completed.')
    } finally { setDownload(false) }
  }

  if (!selected) return null

  return <section className="nw-report" aria-labelledby="nw-report-title">
    <div className="nw-report-banner"><span className="nw-report-icon"><FileChartColumnIncreasing size={19} aria-hidden="true" /></span><div className="nw-report-copy"><span className="nw-report-kicker">SOURCE GROUNDED REPORTING</span><strong id="nw-report-title">Create a {title} report</strong><small>AI analysis where available · source graphs · downloadable PDF</small></div>
      <button type="button" className="nw-report-open" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls="nw-report-builder">{open ? <><X size={15} aria-hidden="true" /> Close</> : <><FileText size={15} aria-hidden="true" /> Create report</>}</button>
    </div>
    {open && <div className="nw-report-builder" id="nw-report-builder">
      <p className="nw-report-intro">Generate a report from the connected data for this dashboard. Select the area and period you want covered; source graphs keep their own measurement units.</p>
      <form className="nw-report-form" onSubmit={generate}>
        <label>Area <input maxLength={90} placeholder="National or district name" value={region} onChange={event => setRegion(event.target.value)} /><small>Leave blank for the dashboard’s national or default area.</small></label>
        {dashboard === 'climate' && <label>Climate season<select value={season} onChange={event => setSeason(event.target.value)}><option>Annual</option><option>MAM</option><option>JJA</option><option>SON</option><option>DJF</option></select></label>}
        {dashboard === 'water-services' && <label>Water services section<select value={section} onChange={event => setSection(event.target.value)}><option value="access">Access and coverage</option><option value="operations">Infrastructure operations</option><option value="eo">Earth observation</option></select></label>}
        {dashboard === 'municipal-tariffs' && <label>Source dataset<select value={dataset} onChange={event => setDataset(event.target.value)}><option value="raw">Raw water tariffs</option><option value="municipal">Municipal water tariffs</option><option value="quality">Water quality costs</option></select></label>}
        <label>Start year<input type="number" min="1900" max="2200" inputMode="numeric" placeholder="All available years" value={start} onChange={event => setStart(event.target.value)} /></label>
        <label>End year<input type="number" min="1900" max="2200" inputMode="numeric" placeholder="Latest available" value={end} onChange={event => setEnd(event.target.value)} /></label>
        <div className="nw-report-submit-wrap"><button className="nw-report-submit" type="submit" disabled={status === 'loading'}>{status === 'loading' ? <><LoaderCircle className="nw-report-spin" size={16} aria-hidden="true" /> Analysing connected data…</> : <><Sparkles size={16} aria-hidden="true" /> Generate report</>}</button></div>
      </form>
      {status === 'loading' && <p className="nw-report-progress" role="status" aria-live="polite"><LoaderCircle className="nw-report-spin" size={14} aria-hidden="true" /> Reading this dashboard’s data and preparing graphs and analysis. This may take a little while.</p>}
      {status === 'error' && <div className="nw-report-error" role="alert"><AlertCircle size={17} aria-hidden="true" /><div><strong>Report generation failed</strong><span>{error}</span></div><button type="button" onClick={() => setStatus('idle')}>Try again</button></div>}
      {status === 'ready' && report && <div className="nw-report-result" aria-live="polite">
        <div className="nw-report-result-head"><span className="nw-report-success"><CheckCircle2 size={16} aria-hidden="true" /> Report ready</span><span>{generatedDate}</span></div>
        <h3>{report.title}</h3><p className="nw-report-summary">{report.summary}</p>
        {report.observed_periods?.length > 0 && <p className="nw-report-period"><strong>Observed coverage:</strong> {report.observed_periods.join(' · ')}</p>}
        {report.analysis_method === 'gemini' ? <p className="nw-report-ai"><Bot size={15} aria-hidden="true" /> Gemini analysed source summaries and graph values</p> : <p className="nw-report-notice"><AlertCircle size={15} aria-hidden="true" /> {report.ai_notice || 'This PDF uses source-derived statistical analysis.'}</p>}
        {report.findings?.length > 0 && <div className="nw-report-findings"><strong>Key findings</strong><ul>{report.findings.slice(0, 4).map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
        {report.limitations?.length > 0 && <details className="nw-report-limits"><summary>Analysis notes and limitations</summary><ul>{report.limitations.slice(0, 6).map((item, index) => <li key={index}>{item}</li>)}</ul></details>}
        <div className="nw-report-bottom"><span>{report.chart_count} source graph{report.chart_count === 1 ? '' : 's'} in the PDF · {report.indicators?.length || 0} indicator summaries · {report.sources?.length || 0} source note{report.sources?.length === 1 ? '' : 's'}</span><button type="button" onClick={downloadPdf} disabled={download}>{download ? <LoaderCircle className="nw-report-spin" size={15} aria-hidden="true" /> : <ArrowDownToLine size={16} aria-hidden="true" />}{download ? 'Preparing…' : 'Download PDF'}</button></div>
        {downloadError && <p className="nw-report-download-error" role="alert">{downloadError}</p>}
      </div>}
      <div className="nw-report-privacy"><Bot size={14} aria-hidden="true" /><span>Gemini receives calculated summaries, graph values and the selected report area. If Gemini is unavailable, the PDF clearly identifies its source-derived statistical analysis.</span></div>
    </div>}
  </section>
}
